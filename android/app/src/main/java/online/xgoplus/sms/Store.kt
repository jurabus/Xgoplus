package online.xgoplus.sms

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/** Small persistent state: device token, outgoing SMS queue, recent activity log. */
class Store(ctx: Context) {
    private val p = ctx.applicationContext.getSharedPreferences("xgo_sms", Context.MODE_PRIVATE)

    var token: String?
        get() = p.getString("token", null)
        set(v) { p.edit().putString("token", v).apply() }

    val paired: Boolean get() = !token.isNullOrBlank()

    var serverEnabled: Boolean
        get() = p.getBoolean("server_enabled", false)
        set(v) { p.edit().putBoolean("server_enabled", v).apply() }

    var lastBeat: Long
        get() = p.getLong("last_beat", 0)
        set(v) { p.edit().putLong("last_beat", v).apply() }

    var lastError: String
        get() = p.getString("last_error", "") ?: ""
        set(v) { p.edit().putString("last_error", v).apply() }

    @Synchronized
    fun enqueue(sender: String, body: String, at: Long) {
        val q = queue()
        // drop exact duplicates still waiting
        for (i in 0 until q.length()) {
            val o = q.getJSONObject(i)
            if (o.optString("sender") == sender && o.optString("body") == body && o.optLong("at") == at) return
        }
        q.put(JSONObject().put("sender", sender).put("body", body).put("at", at))
        while (q.length() > 500) q.remove(0)
        p.edit().putString("queue", q.toString()).apply()
    }

    @Synchronized
    fun queue(): JSONArray = try { JSONArray(p.getString("queue", "[]")) } catch (_: Exception) { JSONArray() }

    @Synchronized
    fun dropFirst() {
        val q = queue()
        if (q.length() > 0) q.remove(0)
        p.edit().putString("queue", q.toString()).apply()
    }

    @Synchronized
    fun log(line: String) {
        val l = logLines()
        l.put(JSONObject().put("t", System.currentTimeMillis()).put("m", line.take(160)))
        while (l.length() > 40) l.remove(0)
        p.edit().putString("log", l.toString()).apply()
    }

    @Synchronized
    fun logLines(): JSONArray = try { JSONArray(p.getString("log", "[]")) } catch (_: Exception) { JSONArray() }

    fun unpair() {
        p.edit().remove("token").remove("queue").putBoolean("server_enabled", false).apply()
    }
}
