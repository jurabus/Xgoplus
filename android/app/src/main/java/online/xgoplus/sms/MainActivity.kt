package online.xgoplus.sms

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.provider.Telephony
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import java.text.DateFormat
import java.util.Date

/** One screen: pair the phone, grant permissions, see what was forwarded. */
class MainActivity : Activity() {
    private lateinit var store: Store
    private lateinit var root: LinearLayout
    private val ui = Handler(Looper.getMainLooper())
    private val purple = Color.parseColor("#2A1670")
    private val brand = Color.parseColor("#6A2EE8")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = Store(this)
        root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(20), dp(28), dp(20), dp(28)) }
        setContentView(ScrollView(this).apply { addView(root); setBackgroundColor(Color.parseColor("#F6F4FF")) })
    }

    override fun onResume() {
        super.onResume()
        render()
        if (store.paired) { Work.schedule(this); bg { beat() } }
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
    private fun bg(f: () -> Unit) = Thread { f() }.start()
    private fun main(f: () -> Unit) = ui.post(f)

    private fun text(s: String, size: Float = 15f, bold: Boolean = false, color: Int = Color.parseColor("#1D1452")) =
        TextView(this).apply {
            text = s; textSize = size; setTextColor(color)
            if (bold) typeface = Typeface.DEFAULT_BOLD
            setPadding(0, dp(4), 0, dp(4))
        }

    private fun button(label: String, primary: Boolean = true, onClick: () -> Unit) = Button(this).apply {
        text = label; isAllCaps = false; textSize = 15f
        setTextColor(if (primary) Color.WHITE else brand)
        background = GradientDrawable().apply {
            cornerRadius = dp(14).toFloat()
            if (primary) setColor(brand) else { setColor(Color.WHITE); setStroke(dp(1), brand) }
        }
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(52)).apply { topMargin = dp(10) }
        setOnClickListener { onClick() }
    }

    private fun card(vararg views: View) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(16), dp(14), dp(16), dp(14))
        background = GradientDrawable().apply { cornerRadius = dp(18).toFloat(); setColor(Color.WHITE); setStroke(dp(1), Color.parseColor("#DDD5F7")) }
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(14) }
        views.forEach { addView(it) }
    }

    private fun hasSms() = checkSelfPermission(Manifest.permission.RECEIVE_SMS) == PackageManager.PERMISSION_GRANTED &&
        checkSelfPermission(Manifest.permission.READ_SMS) == PackageManager.PERMISSION_GRANTED

    private fun batteryOk() = (getSystemService(POWER_SERVICE) as PowerManager).isIgnoringBatteryOptimizations(packageName)

    private fun render() {
        root.removeAllViews()
        root.addView(text("XGo+ SMS Listener", 24f, true, purple))
        root.addView(text("Confirms InstaPay and wallet payments automatically by forwarding the bank's \"money received\" SMS to XGo+. Personal messages never leave this phone.", 14f, color = Color.parseColor("#4B4570")))

        // 1) permissions
        val perm = hasSms()
        root.addView(card(
            text("1 · SMS permission", 17f, true),
            text(if (perm) "✓ Allowed" else "Needed to read incoming bank SMS.", 14f, color = if (perm) Color.parseColor("#0F8A4B") else Color.parseColor("#B3261E")),
            *(if (perm) emptyArray<View>() else arrayOf<View>(
                button("Allow SMS access") { requestPermissions(arrayOf(Manifest.permission.RECEIVE_SMS, Manifest.permission.READ_SMS), 1) },
                text("If Android says the setting is restricted: open App info › ⋮ (top right) › Allow restricted settings, then try again.", 13f, color = Color.parseColor("#4B4570")),
                button("Open App info", false) { startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))) }
            )),
        ))

        // 2) pairing
        if (!store.paired) {
            val code = EditText(this).apply {
                hint = "8-character code"; textSize = 22f; isAllCaps = true; gravity = Gravity.CENTER
                inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
                letterSpacing = 0.2f
            }
            root.addView(card(
                text("2 · Connect to XGo+", 17f, true),
                text("In the XGo+ admin panel open Payments › Automatic payments › Pair a phone, then type the code here.", 14f),
                code,
                button("Connect") {
                    val c = code.text.toString().trim()
                    if (c.length < 8) { toast("Enter the 8-character code"); return@button }
                    bg {
                        try {
                            store.token = Api.pair(c, "${Build.MANUFACTURER} ${Build.MODEL}")
                            store.log("Connected to XGo+")
                            Work.schedule(this); beat()
                            main { toast("Connected"); render() }
                        } catch (e: Exception) {
                            main { toast(if (e is Api.ServerError) e.code.ifBlank { "Failed" } else "No internet connection") }
                        }
                    }
                }
            ))
        } else {
            val ago = if (store.lastBeat > 0) DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(store.lastBeat)) else "—"
            root.addView(card(
                text("2 · Connected to XGo+", 17f, true),
                text(if (store.serverEnabled) "✓ Automatic payments are ON in the admin panel" else "Automatic payments are OFF in the admin panel (SMS are still saved and matched once you switch it on).", 14f,
                    color = if (store.serverEnabled) Color.parseColor("#0F8A4B") else Color.parseColor("#8A5A00")),
                text("Last check-in: $ago · waiting to send: ${store.queue().length()}", 13f, color = Color.parseColor("#4B4570")),
                *(if (store.lastError.isNotBlank()) arrayOf<View>(text("Last problem: ${store.lastError.take(120)}", 13f, color = Color.parseColor("#B3261E"))) else emptyArray<View>()),
                button("Check connection now", false) { bg { beat(); Work.drain(this); main { render() } } },
                button("Send bank SMS from the last 3 days", false) { if (hasSms()) bg { backfill() } else toast("Allow SMS access first") },
                button("Disconnect this phone", false) { store.unpair(); Work.cancel(this); render() }
            ))
        }

        // 3) keep running
        val bat = batteryOk()
        root.addView(card(
            text("3 · Keep it running", 17f, true),
            text(if (bat) "✓ Battery optimisation is off for this app" else "Let the app run in the background so SMS are sent even when the screen is off.", 14f,
                color = if (bat) Color.parseColor("#0F8A4B") else Color.parseColor("#8A5A00")),
            *(if (bat) emptyArray<View>() else arrayOf<View>(button("Don't restrict battery") {
                try { startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))) }
                catch (_: Exception) { startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) }
            })),
            text("Keep this phone charged, on mobile data or Wi-Fi, with the InstaPay/wallet SIM inside.", 13f, color = Color.parseColor("#4B4570"))
        ))

        // activity
        val log = store.logLines()
        val lines = (log.length() - 1 downTo maxOf(0, log.length() - 12)).joinToString("\n") {
            val o = log.getJSONObject(it)
            "${DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(o.getLong("t")))}  ${o.getString("m")}"
        }
        root.addView(card(text("Recent activity", 17f, true), text(lines.ifBlank { "Nothing yet." }, 13f, color = Color.parseColor("#4B4570"))))
        root.addView(text("Version ${BuildConfig.VERSION_NAME}", 12f, color = Color.parseColor("#8E88B0")).apply { gravity = Gravity.CENTER })
    }

    private fun beat() {
        val t = store.token ?: return
        try {
            store.serverEnabled = Api.heartbeat(t, Work.info(this, store))
            store.lastBeat = System.currentTimeMillis()
            store.lastError = ""
        } catch (e: Exception) {
            store.lastError = e.message ?: e.toString()
            if (Api.isRevoked(e)) store.unpair()
        }
        main { if (!isFinishing) render() }
    }

    /** Re-sends matching bank SMS of the last 3 days (e.g. after the phone was offline). The server ignores duplicates. */
    private fun backfill() {
        val since = System.currentTimeMillis() - 3L * 24 * 3600 * 1000
        var n = 0
        contentResolver.query(Telephony.Sms.Inbox.CONTENT_URI,
            arrayOf(Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE, Telephony.Sms.DATE_SENT),
            "${Telephony.Sms.DATE} > ?", arrayOf(since.toString()), "${Telephony.Sms.DATE} ASC")?.use { c ->
            while (c.moveToNext()) {
                val sender = c.getString(0) ?: continue
                val body = c.getString(1) ?: continue
                val sent = c.getLong(3)
                if (SmsFilter.shouldForward(sender, body)) { store.enqueue(sender, body, if (sent > 0) sent else c.getLong(2)); n++ }
            }
        }
        store.log("Re-sending $n bank SMS")
        val ok = Work.drain(this)
        if (!ok) Work.forwardNow(this)
        main { toast("Found $n bank SMS"); render() }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        render()
    }

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_LONG).show()
}
