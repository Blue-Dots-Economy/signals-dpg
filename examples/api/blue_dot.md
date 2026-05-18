# Blue Dot API Payload Examples

## Create seeker item

```json
{
  "item_network": "blue_dot",
  "item_domain": "seeker",
  "item_type": "profile_1.0",
  "item_state": {
    "name": "Aisha Khan",
    "skills": ["typescript", "react", "sql"],
    "preferred_city": "Mumbai",
    "experience_years": 3,
    "open_to_remote": true
  }
}
```

## Create provider job item

```json
{
  "item_network": "blue_dot",
  "item_domain": "provider",
  "item_type": "job_posting_1.0",
  "item_state": {
    "company_name": "Acme Labs",
    "role": "Backend Engineer",
    "city": "Pune",
    "employment_type": "full_time",
    "salary_range": "18L-24L",
    "required_skills": ["nodejs", "postgres", "redis"]
  }
}
```

## Perform apply action

```json
{
  "action_type": "apply",
  "source_item": {
    "item_network": "blue_dot",
    "item_domain": "seeker",
    "item_type": "profile_1.0",
    "item_id": "11111111-2222-3333-4444-555555555555"
  },
  "target_item": {
    "item_network": "blue_dot",
    "item_domain": "provider",
    "item_type": "job_posting_1.0",
    "item_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
  },
  "requirements_snapshot": {
    "job_id": "job_backend_engineer_01",
    "cover_note": "Interested in backend systems and platform work.",
    "resume_url": "https://files.example.com/resumes/aisha.pdf"
  },
  "created_by": "REAL_USER_ID",
  "response_event_type": "application_status",
  "response_event_metadata": {
    "request_id": "req_bd_001",
    "source": "manual_test"
  }
}
```
