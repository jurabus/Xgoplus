package online.xgoplus.sms

/**
 * Data minimisation (Egypt PDPL, Law 151/2020): only "money received" notifications
 * from banks / wallets ever leave this phone. Everything else stays on the device:
 *  - personal SMS (the sender must be a bank/wallet name or a short code, never a person's number);
 *  - anything that looks like a code / OTP / password / PIN, even if it mentions an amount;
 *  - debits, purchases, withdrawals, outgoing transfers, bills;
 *  - salary / payroll alerts;
 *  - anything without both an amount and an incoming-credit wording.
 * The same rules run again on the server (parse_bank_sms), and non-payment SMS are
 * never stored there in readable form.
 */
object SmsFilter {
    private val letters = Regex("[A-Za-z]")
    private val shortCode = Regex("^[0-9]{3,6}$")

    // codes / secrets: never forwarded
    private val secret = Regex(
        "(\\bOTP\\b|one[- ]?time|\\bcode\\b|\\bPIN\\b|passcode|password|verification|verify|authenticat|3-?D ?Secure|" +
            "كود|الكود|رمز|الرمز|كلمة|كلمه|السر|المرور|التحقق|تحقق|التفعيل|تفعيل|لا تشارك|لاتشارك|لا تعطي|صالح لمدة|صالحة لمدة)",
        RegexOption.IGNORE_CASE,
    )

    // money going out, bills, salary: never forwarded
    private val notCredit = Regex(
        "(debit|debited|withdraw|purchase|spent|paid to|payment of|sent to|you sent|transfer(?:red)? to|bill|instal?lment|" +
            "salary|payroll|خصم|سحب|شراء|مشتريات|دفع|سداد|فاتورة|قسط|تم تحويل مبلغ|تم تحويل .{0,40}(?:إلى|الى|لرقم|ل رقم)|راتب|مرتب|المرتب)",
        RegexOption.IGNORE_CASE,
    )

    // must say money came in
    private val credit = Regex(
        "(إضافة|اضافة|إيداع|ايداع|استلام|استقبال|تم استلام|وارد|received|credited|deposited|incoming|has been added)",
        RegexOption.IGNORE_CASE,
    )

    // must mention an amount
    private val amount = Regex("(مبلغ|بمبلغ|جم|جنيه|ج\\.م|EGP|\\bLE\\b)", RegexOption.IGNORE_CASE)

    fun senderOk(sender: String): Boolean {
        val s = sender.trim()
        return letters.containsMatchIn(s) || shortCode.matches(s)
    }

    fun shouldForward(sender: String, body: String): Boolean =
        senderOk(sender) &&
            !secret.containsMatchIn(body) &&
            !notCredit.containsMatchIn(body) &&
            credit.containsMatchIn(body) &&
            amount.containsMatchIn(body)
}
