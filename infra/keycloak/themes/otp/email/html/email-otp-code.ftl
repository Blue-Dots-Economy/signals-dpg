<#import "template.ftl" as layout>
<@layout.emailLayout>
${kcSanitize(msg("emailOtpBodyHtml", code))?no_esc}
</@layout.emailLayout>
