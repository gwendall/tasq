# tasq-remote for Python

This is a thin synchronous client for the authenticated Tasq Server API. It
does not embed Core, open SQLite, run migrations or reproduce authorization.

```python
import os
from tasq_remote import TasqRemote, redeem_remote_enrollment

credential = redeem_remote_enrollment(
    endpoint="https://server.example/",
    workspace_id="operations/alpha",
    enrollment_token=os.environ["TASQ_ENROLLMENT_TOKEN"],
)

tasq = TasqRemote(
    endpoint="https://server.example/",
    workspace_id="operations/alpha",
    access_token=credential["accessToken"],
)

for item in tasq.list_commitments(limit=20)["items"]:
    print(item["id"], item["title"])
```

Mutations require an explicit resource, idempotency key and stable request ID:

```python
result = tasq.execute_operation(
    "claim.acquire",
    resource={"kind": "commitment", "id": commitment_id},
    input={"leaseMs": 1_800_000},
    idempotency_key="worker-42-claim",
    request_id="worker-42-claim-request",
)
```

On an unknown transport result, repeat the exact operation, body,
idempotency key and request ID. Do not invent success.
