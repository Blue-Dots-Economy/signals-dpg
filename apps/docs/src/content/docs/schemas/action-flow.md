---
title: Action Flow Guide
description: How DPG action schemas work and how to model continuous business flows.
head: []
---

Actions describe what one domain can request from another domain. They also define the payload required to request that action and the payload shape for later action events.

## Action Anatomy

```json
{
  "connect": {
    "description": "A student requests to connect with a tutor.",
    "interactions": [
      {
        "from_domain": "student",
        "from_items": ["profile_1.0"],
        "to_domain": "tutor",
        "to_items": ["profile_1.0"],
        "requirement_schema": {
          "type": "object",
          "required": ["subject", "goal"],
          "properties": {
            "subject": { "type": "string" },
            "goal": { "type": "string" }
          }
        },
        "event_schema": {
          "type": "object",
          "required": ["status", "remark"],
          "properties": {
            "status": {
              "type": "string",
              "enum": ["created", "accepted", "rejected"]
            },
            "remark": { "type": "string" }
          }
        }
      }
    ]
  }
}
```

| Field | Purpose |
|-------|---------|
| action type | Stable API value such as `connect`, `apply`, `book_trip` |
| `from_domain` | Domain that initiates the action |
| `from_items` | Source item types allowed to initiate the action |
| `to_domain` | Domain that receives the action |
| `to_items` | Target item types allowed to receive the action |
| `requirement_schema` | Request payload shape |
| `event_schema` | Event/status payload shape |

`from_network` and `to_network` are optional. If omitted, the current network id is used.

## Runtime Flow

1. Source instance receives `POST /api/v1/action/perform`.
2. Source item is checked locally.
3. Target domain and target instance are validated against the network config.
4. Source instance forwards the action to `POST /api/v1/network/action/perform` on the target instance.
5. Target instance validates `requirements_snapshot` against `requirement_schema`.
6. Target instance stores the action and an initial event.
7. Status changes happen through `POST /api/v1/action/update-status`.
8. Events are stored and mirrored back to the source instance when needed.

## Continuous Flow Pattern

DPG does not currently include a workflow engine that automatically triggers the next action. You can still model continuous journeys by chaining actions at the schema level and letting your app or operator decide when to start the next step.

Use this pattern:

1. make every business step a separate action
2. include stable ids in requirement/event payloads
3. include status values in `event_schema`
4. start the next action when the previous action reaches the needed status
5. keep each action owned by the domain that should validate and respond to that step

Example:

```text
apply -> shortlist -> schedule_interview -> offer
```

Each arrow is a separate action with its own requirement schema and event schema.

## Education Flow

```text
connect -> schedule_session -> submit_feedback
```

| Action | From | To | Requirement payload |
|--------|------|----|---------------------|
| `connect` | `student` | `tutor` | subject, goal, preferred mode |
| `schedule_session` | `student` or `tutor` | `tutor` or `student` | action id, proposed time, duration |
| `submit_feedback` | `student` | `tutor` | session id, rating, comment |

The `connect` event can end with `accepted`. The UI can then allow `schedule_session`.

## Jobs Flow

```text
apply -> shortlist -> schedule_interview -> offer
```

| Action | From | To | Requirement payload |
|--------|------|----|---------------------|
| `apply` | `seeker` | `provider` | job id, cover note, resume url |
| `shortlist` | `provider` | `seeker` | application id, screening note |
| `schedule_interview` | `provider` | `seeker` | application id, time slots |
| `offer` | `provider` | `seeker` | role, compensation, joining date |

Use the previous action id or application id to connect every step.

## Women Services Flow

```text
request_support -> assign_case_worker -> schedule_visit -> close_case
```

Suggested domains:

- `beneficiary`
- `service_provider`
- `case_worker`

Suggested payloads:

- support category
- urgency
- location
- case id
- assigned worker id
- visit time
- closure summary

Keep sensitive fields private in item schemas and use minimal event payloads for public/operational updates.

## Travel Flow

```text
request_trip -> quote_trip -> book_trip -> confirm_pickup
```

Suggested domains:

- `traveler`
- `travel_agent`
- `transport_provider`
- `hotel_provider`

Suggested payloads:

- destination
- dates
- travelers count
- quote id
- package id
- pickup location
- confirmation status

Use separate actions for quote, booking, and pickup because each step has different ownership and validation.

## Agriculture Flow

```text
request_advisory -> recommend_input -> place_order -> confirm_delivery
```

Suggested domains:

- `farmer`
- `advisor`
- `input_supplier`
- `logistics_provider`

Suggested payloads:

- crop
- acreage
- issue
- advisory id
- recommended input
- order id
- delivery status

This lets an advisory action produce enough structured data for a later order action.
