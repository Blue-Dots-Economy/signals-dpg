# Yellow Dot API Payload Examples

## Create student item

```json
{
  "item_network": "yellow_dot",
  "item_domain": "student",
  "item_type": "profile_1.0",
  "item_state": {
    "name": "Arya",
    "grade": "10",
    "city": "Bengaluru",
    "preferred_subject": "math"
  }
}
```

## Create tutor item with custom schema

```json
{
  "item_network": "yellow_dot",
  "item_domain": "tutor",
  "item_type": "profile_1.1",
  "item_state": {
    "name": "Ravi",
    "subjects": ["math", "science"],
    "experience_years": 6,
    "teaching_mode": "hybrid"
  }
}
```

## Perform connect action

```json
{
  "action_type": "connect",
  "source_item": {
    "item_network": "yellow_dot",
    "item_domain": "student",
    "item_type": "profile_1.0",
    "item_id": "67b6558e-46f2-45c5-953a-f417e8162332"
  },
  "target_item": {
    "item_network": "yellow_dot",
    "item_domain": "tutor",
    "item_type": "profile_1.1",
    "item_id": "46cc4c8e-f875-40c3-b4f4-e7d211afdc59"
  },
  "requirements_snapshot": {
    "subject": "math",
    "goal": "board_exam_preparation"
  },
  "created_by": "REAL_USER_ID",
  "response_event_type": "action_response",
  "response_event_metadata": {
    "request_id": "req_yd_001",
    "source": "manual_test"
  }
}
```
