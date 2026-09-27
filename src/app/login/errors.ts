/** Maps Supabase auth errors to clear Arabic messages. */
export function loginErrorMessage(error: { code?: string; name?: string; status?: number }) {
  switch (error.code) {
    case "otp_expired":
    case "invalid_credentials":
      return "الرمز غير صحيح أو انتهت صلاحيته";
    case "over_sms_send_rate_limit":
    case "over_request_rate_limit":
      return "محاولات كثيرة، انتظر قليلاً ثم حاول مرة أخرى";
    case "phone_provider_disabled":
    case "sms_send_failed":
      return "تعذّر إرسال الرسالة الآن، حاول لاحقاً";
  }
  if (error.name === "AuthRetryableFetchError" || error.status === 0) {
    return "تعذّر الاتصال، تحقق من الإنترنت وحاول مرة أخرى";
  }
  if (error.status === 429) return "محاولات كثيرة، انتظر قليلاً ثم حاول مرة أخرى";
  return "حدث خطأ، حاول مرة أخرى";
}
