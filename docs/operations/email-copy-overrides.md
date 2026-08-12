# Overriding email copy at deploy time

All email wording (subjects, bodies, button labels) lives in one properties
file. The bundled default ships in the API image at
`apps/api/src/notifications/email/messages.default.properties` (copied to
`dist/` in the build). Ops can override any line without a code change, and
overrides can be scoped instance-wide, per network, or per brand — see
"Layering" below for how the layers combine.

> **Helm-managed environments:** this repo's deployments are managed by the
> Helm chart in the separate charts repo (`values.yaml`, `install.sh` — see
> `docs/operations/secrets.md`). On those environments, add the ConfigMap +
> `volumeMount` + `EMAIL_MESSAGES_PATH` env through the chart (new
> values/templates there), the same way `secrets.md` describes for secrets —
> do **not** hand-edit the rendered Deployment, or `helm upgrade` will revert
> it. The steps and raw `kubectl`/YAML below are the underlying mechanism the
> chart needs to wire up; use them directly only on a non-Helm environment.

## Instance-wide override (`EMAIL_MESSAGES_PATH`)

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

## Layering: defaults < instance < network < brand

Copy can also be overridden per network, and per brand within a network, on
top of the instance-wide override above. Precedence, lowest to highest:

1. **Bundled defaults** — `messages.default.properties`, always complete.
2. **Instance override** — `EMAIL_MESSAGES_PATH`, as configured above.
3. **Network file** — `messages.properties` sitting beside that network's
   `network.json`.
4. **Brand file** — `messages.properties` sitting beside that brand's
   `consent.json` (an immediate sub-folder of the network, named for the
   brand id).

Each layer is **partial**: any key it doesn't set falls through to the layer
below it, all the way down to the bundled default for that key. A request is
resolved for the `(network, brand)` pair it's serving — brand wins over
network, network wins over the instance override, the instance override wins
over the bundled default; an unknown or absent network/brand simply resolves
to the instance-wide (or bundled) copy.

Two resolution nuances worth knowing: action/retire emails resolve copy under
the **counterparty item's network** (`plan.counterpartyNetwork` — the same
network key that also drives the CTA button colour), which is not necessarily
the network of the instance serving the request. And on an instance serving
multiple networks, instance-level emails (OTP, welcome, support — anything
sent with no per-plan network) always resolve to the instance/base copy, never
a network file; only action/retire emails, which carry an explicit network,
pick up network or brand layers on such an instance.

Network and brand `messages.properties` files ride the same discovery and
delivery mechanism as `network.json` and `consent.json` — same directory,
same ConfigMap/volume mount, same local-vs-remote config source. There is no
separate deploy step: if you're already shipping a network's `network.json`
or a brand's `consent.json` through a ConfigMap, add its `messages.properties`
to that same file map and it's picked up automatically. Remote-mode delivery
of these files is a follow-up (local mode only for now).

Per-network/brand template files with this comment-only semantics live in
`examples/schemas/<network>/messages.properties` and
`examples/schemas/<network>/<brand>/messages.properties` — each ships no
active keys, only the header/rule comments and a few commented-out example
lines. Copy one in, uncomment, and edit only the keys you want to change for
that network or brand.

## Rules (also documented in comments inside the file)

- Values are single-line HTML fragments; `<p> <b> <a> <ol> <li>` are fine.
  The outer layout (header, CTA button, colours) is fixed in code.
- Placeholders are `{{likeThis}}`, optional, and per-template (see the
  comment above each section). Anything unrecognised renders as literal text.
- Placeholder VALUES are HTML-escaped automatically — a user's name can never
  inject markup.
- A missing/unparseable file or a typo'd key can never break email: every bad
  or absent key falls back to the layer below it, with a warning in the API
  logs. Each layer's warnings say which layer produced them — `email
  messages override: …` for the instance file, `email messages network
  <network>: …` for a network file, `email messages network <network> brand
  <brand>: …` for a brand file — plus a one-line summary per layer of how
  many keys it overrode versus fell back. `email messages: cannot read
  EMAIL_MESSAGES_PATH …` covers the instance path itself being
  missing/unreadable. If the network/brand file scan itself fails (e.g.
  permission denied, not just a missing file) the API logs `email messages:
  cannot read network/brand messages files (…) — using instance/base copy
  only` and drops every network/brand layer for that boot, falling back to
  the instance override (or bundled defaults) for all networks/brands —
  coarser than the per-layer fallback above, but email still never breaks.
