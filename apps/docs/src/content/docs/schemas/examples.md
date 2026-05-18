---
title: Network Schema Use Case Examples
description: Example domain, item, and action designs for common DPG network use cases.
head: []
---

Use these examples as starting points for designing a network schema. They are intentionally compact and focus on structure rather than full production JSON.

## Education

Suggested domains:

- `student`
- `tutor`
- `coaching_center`

Suggested item types:

- `profile_1.0`
- `course_listing_1.0`
- `session_slot_1.0`

Suggested actions:

- `connect`
- `schedule_session`
- `submit_feedback`

Compact domain example:

```json
{
  "id": "student",
  "item_schemas": {
    "profile_1.0": {
      "type": "object",
      "required": ["name", "grade", "city"],
      "properties": {
        "name": { "type": "string" },
        "grade": { "type": "string" },
        "city": { "type": "string" },
        "phone": { "type": "string", "private": true }
      }
    }
  }
}
```

Flow:

```text
student connect tutor -> tutor accepts -> student schedule_session tutor -> student submit_feedback tutor
```

## Jobs

Suggested domains:

- `seeker`
- `provider`
- `recruiter`

Suggested item types:

- `profile_1.0`
- `job_posting_1.0`
- `company_profile_1.0`

Suggested actions:

- `apply`
- `shortlist`
- `schedule_interview`
- `offer`

Compact action example:

```json
{
  "apply": {
    "interactions": [
      {
        "from_domain": "seeker",
        "to_domain": "provider",
        "requirement_schema": {
          "type": "object",
          "required": ["job_id", "cover_note"],
          "properties": {
            "job_id": { "type": "string" },
            "cover_note": { "type": "string" },
            "resume_url": { "type": "string", "format": "uri" }
          }
        },
        "event_schema": {
          "type": "object",
          "required": ["status", "remark"],
          "properties": {
            "status": {
              "type": "string",
              "enum": ["submitted", "shortlisted", "rejected"]
            },
            "remark": { "type": "string" }
          }
        }
      }
    ]
  }
}
```

## Women Services

Suggested domains:

- `beneficiary`
- `service_provider`
- `case_worker`
- `support_center`

Suggested item types:

- `profile_1.0`
- `service_listing_1.0`
- `case_worker_profile_1.0`

Suggested actions:

- `request_support`
- `assign_case_worker`
- `schedule_visit`
- `close_case`

Important schema choices:

- mark phone, address, identity documents, and case details as `private: true`
- keep public service listings separate from private beneficiary profiles
- use event statuses such as `created`, `assigned`, `scheduled`, `resolved`, `closed`

## Travel

Suggested domains:

- `traveler`
- `travel_agent`
- `transport_provider`
- `hotel_provider`

Suggested item types:

- `traveler_profile_1.0`
- `trip_request_1.0`
- `travel_package_1.0`
- `hotel_listing_1.0`

Suggested actions:

- `request_trip`
- `quote_trip`
- `book_trip`
- `confirm_pickup`

Flow:

```text
traveler request_trip travel_agent -> travel_agent quote_trip traveler -> traveler book_trip travel_agent -> transport_provider confirm_pickup traveler
```

## Agriculture

Suggested domains:

- `farmer`
- `advisor`
- `input_supplier`
- `logistics_provider`

Suggested item types:

- `farmer_profile_1.0`
- `crop_advisory_request_1.0`
- `input_listing_1.0`
- `delivery_offer_1.0`

Suggested actions:

- `request_advisory`
- `recommend_input`
- `place_order`
- `confirm_delivery`

Compact requirement example:

```json
{
  "type": "object",
  "required": ["crop", "issue", "acreage"],
  "properties": {
    "crop": { "type": "string" },
    "issue": { "type": "string" },
    "acreage": { "type": "number" },
    "location": { "type": "string" }
  }
}
```

## Checked-In Examples

Complete checked-in network configs live in:

- `examples/schemas/yellow_dot/network.json`
- `examples/schemas/blue_dot/network.json`

Request payload examples live in:

- `examples/api/yellow_dot.md`
- `examples/api/blue_dot.md`
