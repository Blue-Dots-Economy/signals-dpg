<#-- Shared 6-box OTP wiring. Included by login-email-otp.ftl and login-sms-otp.ftl. -->
<script>
(function () {
    var cells = [];
    for (var i = 0; i < 6; i++) {
        var c = document.getElementById('bd-otp-' + i);
        if (!c) return;
        cells.push(c);
    }
    var hidden = document.getElementById('bd-otp-value');
    var form = cells[0].form;
    var submitBtn = form ? form.querySelector('button[type="submit"], input[type="submit"]') : null;
    if (!hidden || !form) return;

    function readValue() {
        return cells.map(function (c) { return (c.value || '').replace(/\D/g, ''); }).join('');
    }

    function syncHidden() {
        hidden.value = readValue();
        // Gate the submit button: enabled only once all 6 digits are present.
        // Runs on every value change (input/backspace/paste) and on init.
        if (submitBtn) submitBtn.disabled = hidden.value.length !== 6;
    }

    function focusNextEmpty(fromIndex) {
        for (var i = fromIndex; i < cells.length; i++) {
            if (!cells[i].value) {
                cells[i].focus();
                cells[i].select();
                return;
            }
        }
        cells[cells.length - 1].focus();
    }

    function fillFrom(index, digits) {
        var idx = index;
        for (var k = 0; k < digits.length && idx < cells.length; k++, idx++) {
            cells[idx].value = digits.charAt(k);
        }
        syncHidden();
        if (idx >= cells.length) {
            cells[cells.length - 1].blur();
            maybeAutoSubmit();
        } else {
            focusNextEmpty(idx);
        }
    }

    function maybeAutoSubmit() {
        if (readValue().length === 6 && submitBtn && !submitBtn.disabled) {
            // Defer to allow paint of last digit before submit.
            setTimeout(function () { form.requestSubmit ? form.requestSubmit(submitBtn) : form.submit(); }, 30);
        }
    }

    cells.forEach(function (cell, i) {
        cell.addEventListener('input', function (e) {
            var raw = (cell.value || '').replace(/\D/g, '');
            if (raw.length > 1) {
                cell.value = '';
                fillFrom(i, raw);
                return;
            }
            cell.value = raw;
            syncHidden();
            if (raw && i < cells.length - 1) {
                cells[i + 1].focus();
                cells[i + 1].select();
            }
            if (i === cells.length - 1 && raw) {
                maybeAutoSubmit();
            }
        });

        cell.addEventListener('keydown', function (e) {
            if (e.key === 'Backspace') {
                if (!cell.value && i > 0) {
                    e.preventDefault();
                    cells[i - 1].focus();
                    cells[i - 1].value = '';
                    syncHidden();
                }
                return;
            }
            if (e.key === 'ArrowLeft' && i > 0) { e.preventDefault(); cells[i - 1].focus(); cells[i - 1].select(); return; }
            if (e.key === 'ArrowRight' && i < cells.length - 1) { e.preventDefault(); cells[i + 1].focus(); cells[i + 1].select(); return; }
            if (e.key === 'Enter') { return; }
            if (e.metaKey || e.ctrlKey) return;
            if (e.key.length === 1 && !/[0-9]/.test(e.key)) {
                e.preventDefault();
            }
        });

        cell.addEventListener('focus', function () { cell.select(); });

        cell.addEventListener('paste', function (e) {
            var data = (e.clipboardData || window.clipboardData).getData('text');
            if (!data) return;
            var digits = data.replace(/\D/g, '').slice(0, 6 - i);
            if (!digits) return;
            e.preventDefault();
            fillFrom(i, digits);
        });
    });

    form.addEventListener('submit', function (e) {
        syncHidden();
        if (hidden.value.length !== 6) {
            e.preventDefault();
            focusNextEmpty(0);
            return;
        }
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.classList.add('is-loading');
        }
    });

    // Pre-fill if browser provided autofill on the first cell.
    syncHidden();
})();
</script>
