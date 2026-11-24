package online.xgoplus.sms

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony

/** Called by Android for every incoming SMS, even when the app is closed. */
class SmsReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        val store = Store(ctx)
        if (!store.paired) return
        val parts = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
        // long messages arrive in several parts: join them per sender
        val bySender = LinkedHashMap<String, Pair<StringBuilder, Long>>()
        for (m in parts) {
            val sender = m.displayOriginatingAddress ?: m.originatingAddress ?: continue
            val e = bySender.getOrPut(sender) { Pair(StringBuilder(), m.timestampMillis) }
            e.first.append(m.displayMessageBody ?: m.messageBody ?: "")
        }
        var queued = 0
        for ((sender, v) in bySender) {
            val body = v.first.toString()
            if (SmsFilter.shouldForward(sender, body)) {
                store.enqueue(sender, body, if (v.second > 0) v.second else System.currentTimeMillis())
                queued++
            }
        }
        if (queued == 0) return
        // try right away (a few seconds); WorkManager retries later if there is no internet
        val pending = goAsync()
        Thread {
            try { if (!Work.drain(ctx)) Work.forwardNow(ctx) }
            catch (_: Exception) { Work.forwardNow(ctx) }
            finally { pending.finish() }
        }.start()
    }
}
