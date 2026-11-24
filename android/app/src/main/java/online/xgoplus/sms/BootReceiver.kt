package online.xgoplus.sms

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** After a restart or an app update: keep the heartbeat running and flush the queue. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (!Store(ctx).paired) return
        Work.schedule(ctx)
        Work.forwardNow(ctx)
    }
}
