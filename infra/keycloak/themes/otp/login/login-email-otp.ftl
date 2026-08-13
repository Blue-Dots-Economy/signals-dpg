<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=!messagesPerField.existsError('otp'); section>
<!-- template: login-email-otp.ftl -->

    <#if section="header">
        ${msg("emailOtpTitle")}
    <#elseif section="form">
        <form id="kc-email-otp-form"
              class="${properties.kcFormClass!} bd-otp-form"
              action="${url.loginAction}"
              method="post"
              novalidate="novalidate">
            <div class="${properties.kcFormGroupClass!}">
                <label class="${properties.kcLabelClass!}" for="bd-otp-0">${msg("emailOtpLabel")}</label>
                <div class="bd-otp-grid" role="group" aria-label="${msg('emailOtpLabel')}">
                    <#list 0..5 as i>
                        <input class="bd-otp-cell"
                               id="bd-otp-${i}"
                               type="text"
                               inputmode="numeric"
                               autocomplete="one-time-code"
                               pattern="[0-9]*"
                               maxlength="1"
                               aria-label="Digit ${i + 1}"
                               <#if i==0>autofocus</#if> />
                    </#list>
                </div>
                <input type="hidden" name="otp" id="bd-otp-value" value="" />
                <#if messagesPerField.existsError('otp')>
                    <div class="bd-otp-error" aria-live="polite">${kcSanitize(messagesPerField.get('otp'))?no_esc}</div>
                </#if>
            </div>

            <div class="${properties.kcFormGroupClass!}">
                <button class="${properties.kcButtonClass!} ${properties.kcButtonPrimaryClass!} ${properties.kcButtonBlockClass!} ${properties.kcButtonLargeClass!} bd-submit"
                        name="login"
                        id="kc-login"
                        type="submit">
                    <span class="bd-submit-label">${msg('doLogIn')}</span>
                    <span class="bd-spinner" aria-hidden="true"></span>
                </button>
            </div>
        </form>

        <#include "otp-cells.ftl" />
    </#if>
</@layout.registrationLayout>
