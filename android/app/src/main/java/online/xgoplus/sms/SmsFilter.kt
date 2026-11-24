package online.xgoplus.sms

/**
 * Only money notifications from banks / wallets leave the phone:
 *  - the sender is a name (NBE, VF-Cash, Etisalat…) or a short code, never a person's number;
 *  - the text mentions an amount.
 * Everything else (personal SMS, OTPs without amounts) stays on the phone.
 */
object SmsFilter {
    private val money = Regex("(مبلغ|بمبلغ|جم|جنيه|ج\\.م|EGP|\\bLE\\b|InstaPay|انستاباي|إنستاباي)", RegexOption.IGNORE_CASE)
    private val letters = Regex("[A-Za-z]")
    private val shortCode = Regex("^[0-9]{3,6}$")

    fun senderOk(sender: String): Boolean {
        val s = sender.trim()
        return letters.containsMatchIn(s) || shortCode.matches(s)
    }

    fun shouldForward(sender: String, body: String): Boolean =
        senderOk(sender) && money.containsMatchIn(body)
}
