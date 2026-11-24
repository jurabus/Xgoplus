package online.xgoplus.sms

import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/** Calls the XGo+ database functions (Supabase PostgREST RPC) with the public key. */
object Api {
    class ServerError(val code: String, msg: String, val http: Int) : Exception(msg)

    private fun call(fn: String, body: JSONObject): String {
        val c = URL("${BuildConfig.SUPABASE_URL}/rest/v1/rpc/$fn").openConnection() as HttpURLConnection
        try {
            c.requestMethod = "POST"
            c.connectTimeout = 15000
            c.readTimeout = 20000
            c.doOutput = true
            c.setRequestProperty("apikey", BuildConfig.SUPABASE_KEY)
            c.setRequestProperty("Content-Type", "application/json")
            c.setRequestProperty("Accept", "application/json")
            c.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            val code = c.responseCode
            val text = (if (code in 200..299) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
            if (code !in 200..299) {
                val msg = try { JSONObject(text).optString("message", text) } catch (_: Exception) { text }
                throw ServerError(msg.trim(), "HTTP $code: $msg", code)
            }
            return text
        } finally {
            c.disconnect()
        }
    }

    fun iso(ms: Long): String = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
        .apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date(ms))

    /** Exchanges the 8-character code from Admin → Payments for a device token. */
    fun pair(code: String, name: String): String {
        val r = JSONObject(call("sms_pair", JSONObject().put("p_code", code).put("p_name", name)))
        return r.getString("token")
    }

    /** → whether automatic payments are switched on in the admin panel. */
    fun heartbeat(token: String, info: String): Boolean {
        val r = JSONObject(call("sms_heartbeat", JSONObject().put("p_token", token).put("p_info", info)))
        return r.optBoolean("enabled", false)
    }

    /** Sends one SMS (raw text). The database parses it and matches payments. */
    fun ingest(token: String, sender: String, body: String, at: Long): JSONObject =
        JSONObject(call("sms_ingest", JSONObject().put("p_token", token).put("p_sender", sender)
            .put("p_body", body).put("p_sms_at", iso(at))))

    fun isRevoked(e: Exception) = e is ServerError && e.code.contains("device_revoked")
    fun isNetwork(e: Exception) = e is IOException
}
