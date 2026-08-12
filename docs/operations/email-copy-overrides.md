# Overriding email copy at deploy time

All email wording (subjects, bodies, button labels) lives in one properties
file. The bundled default ships in the API image at
`apps/api/src/notifications/email/messages.default.properties` (copied to
`dist/` in the build). Ops can override any line without a code change:

1. Copy the bundled file into a ConfigMap:
   `kubectl create configmap signals-email-messages --from-file=messages.properties=messages.default.properties`
2. Edit the wording you want to change. Keys you delete simply fall back to
   the bundled default — you can keep an override file containing ONLY the
   keys you changed.
3. Mount it and point the API at it:

   ```yaml
   volumeMounts:
     - name: email-messages
       mountPath: /etc/signals/email
   volumes:
     - name: email-messages
       configMap:
         name: signals-email-messages
   env:
     - name: EMAIL_MESSAGES_PATH
       value: /etc/signals/email/messages.properties
   ```

4. Restart the pods — the file is read once at boot.

Rules (also documented in comments inside the file):

- Values are single-line HTML fragments; `<p> <b> <a> <ol> <li>` are fine.
  The outer layout (header, CTA button, colours) is fixed in code.
- Placeholders are `{{likeThis}}`, optional, and per-template (see the
  comment above each section). Anything unrecognised renders as literal text.
- Placeholder VALUES are HTML-escaped automatically — a user's name can never
  inject markup.
- A missing/unparseable file or a typo'd key can never break email: every bad
  or absent key falls back to the bundled default, with a warning in the API
  logs (`email messages override: …`).
