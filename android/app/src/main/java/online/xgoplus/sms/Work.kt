package online.xgoplus.sms

import android.content.Context
import android.os.Build
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.concurrent.TimeUnit

object Work {
    private val net = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    /** Send queued SMS as soon as there is internet; retries with backoff until delivered. */
    fun forwardNow(ctx: Context) {
        val req = OneTimeWorkRequestBuilder<ForwardWorker>()
            .setConstraints(net)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(ctx).enqueueUniqueWork("forward", ExistingWorkPolicy.REPLACE, req)
    }

    /** Every 15 minutes: tell the admin panel the phone is alive, and flush anything left in the queue. */
    fun schedule(ctx: Context) {
        val req = PeriodicWorkRequestBuilder<HeartbeatWorker>(15, TimeUnit.MINUTES).setConstraints(net).build()
        WorkManager.getInstance(ctx).enqueueUniquePeriodicWork("heartbeat", ExistingPeriodicWorkPolicy.UPDATE, req)
    }

    fun cancel(ctx: Context) {
        WorkManager.getInstance(ctx).cancelUniqueWork("heartbeat")
        WorkManager.getInstance(ctx).cancelUniqueWork("forward")
    }

    fun info(ctx: Context, store: Store) =
        "Android ${Build.VERSION.RELEASE} · ${Build.MANUFACTURER} ${Build.MODEL} · app ${BuildConfig.VERSION_NAME} · queue ${store.queue().length()}"

    private val lock = Any()

    /** Sends the queue in order (one sender at a time). Returns false if it should be retried later. */
    fun drain(ctx: Context): Boolean = synchronized(lock) { drainLocked(ctx) }

    private fun drainLocked(ctx: Context): Boolean {
        val store = Store(ctx)
        val token = store.token ?: return true
        while (true) {
            val q = store.queue()
            if (q.length() == 0) return true
            val o = q.getJSONObject(0)
            try {
                val r = Api.ingest(token, o.getString("sender"), o.getString("body"), o.getLong("at"))
                val what = when {
                    r.optBoolean("matched") -> "✓ matched a payment"
                    r.optBoolean("duplicate") -> "already sent"
                    else -> r.optString("kind", "stored")
                }
                store.log("${o.getString("sender")}: $what")
                store.lastError = ""
                store.dropFirst()
            } catch (e: Exception) {
                store.lastError = e.message ?: e.toString()
                if (Api.isRevoked(e)) { store.log("Disconnected by admin — pair again"); store.unpair(); return true }
                if (e is Api.ServerError && e.http in 400..499 && e.http != 429 && !e.code.contains("rate_limited")) { store.log("Rejected: ${e.code}"); store.dropFirst(); continue }
                return false
            }
        }
    }
}

class ForwardWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        if (Work.drain(applicationContext)) Result.success() else Result.retry()
    }
}

class HeartbeatWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val store = Store(applicationContext)
        val token = store.token ?: return@withContext Result.success()
        try {
            store.serverEnabled = Api.heartbeat(token, Work.info(applicationContext, store))
            store.lastBeat = System.currentTimeMillis()
            store.lastError = ""
        } catch (e: Exception) {
            store.lastError = e.message ?: e.toString()
            if (Api.isRevoked(e)) { store.unpair(); return@withContext Result.success() }
        }
        Work.drain(applicationContext)
        Result.success()
    }
}
