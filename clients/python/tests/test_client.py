from __future__ import annotations

import json
import unittest
from pathlib import Path
from typing import Mapping

from tasq_remote import TasqRemote, TasqRemoteError


class FixtureTransport:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, Mapping[str, str], bytes | None]] = []
        self.fail_next = False

    def __call__(self, method, url, headers, body):
        self.calls.append((method, url, headers, body))
        request_id = headers["x-tasq-request-id"]
        if self.fail_next:
            self.fail_next = False
            return 503, {}, json.dumps({
                "contractVersion": "tasq.hosted-problem.v1",
                "code": "authority_busy",
                "requestId": request_id,
            }).encode()
        if url.endswith("v1/operations"):
            value = {
                "contractVersion": "tasq.hosted-operation-catalog.v1",
                "operations": [],
            }
        elif "/operations/" in url:
            value = {
                "contractVersion": "tasq.hosted-mutation-response.v1",
                "requestId": request_id,
                "decisionId": "decision-1",
                "evaluatedAt": 1,
                "authorityRevision": 1,
                "outcome": {
                    "contractVersion": "tasq.hosted-mutation-outcome.v1",
                    "workspaceId": "team/acme",
                    "operationId": "commitment.propose",
                    "requestDigest": "sha256:" + "a" * 64,
                    "idempotencyKeyDigest": "sha256:" + "b" * 64,
                    "resultType": "commitment",
                    "resultId": "commitment-1",
                    "resultRevision": 1,
                    "eventSequence": 1,
                    "replayed": False,
                    "result": {"id": "commitment-1"},
                },
            }
        elif "/events?" in url:
            value = {
                "contractVersion": "tasq.hosted-event-metadata-page.v1",
                "requestId": request_id,
                "decisionId": "decision-1",
                "evaluatedAt": 1,
                "items": [],
                "nextSequence": None,
            }
        elif "/commitments/" in url and "?" not in url:
            value = {
                "contractVersion": "tasq.hosted-commitment.v1",
                "requestId": request_id,
                "decisionId": "decision-1",
                "evaluatedAt": 1,
                "item": {"id": "commitment-1"},
            }
        else:
            value = {
                "contractVersion": "tasq.hosted-commitment-page.v1",
                "requestId": request_id,
                "decisionId": "decision-1",
                "evaluatedAt": 1,
                "items": [],
                "nextCursor": None,
            }
        return 200, {"content-type": "application/json"}, json.dumps(value).encode()


class TasqRemoteTests(unittest.TestCase):
    def setUp(self):
        self.transport = FixtureTransport()
        self.client = TasqRemote(
            endpoint="https://server.example/",
            workspace_id="team/acme",
            access_token="opaque-token",
            transport=self.transport,
            request_id_factory=lambda: "request-generated",
        )

    def test_reads_and_exact_mutation_envelope(self):
        self.client.list_commitments(limit=20)
        self.client.get_commitment("commitment-1")
        self.client.list_events(after_sequence=42, limit=10)
        self.client.list_operations()
        outcome = self.client.execute_operation(
            "commitment.propose",
            resource={"kind": "workspace", "id": "team/acme"},
            input={"title": "From Python"},
            idempotency_key="create-python",
            request_id="create-python-request",
        )
        self.assertEqual(outcome["resultId"], "commitment-1")
        method, url, headers, body = self.transport.calls[-1]
        self.assertEqual(method, "POST")
        self.assertTrue(url.endswith(
            "v1/workspaces/team%2Facme/operations/commitment.propose"
        ))
        self.assertEqual(headers["authorization"], "Bearer opaque-token")
        self.assertEqual(headers["idempotency-key"], "create-python")
        self.assertEqual(headers["x-tasq-request-id"], "create-python-request")
        self.assertEqual(json.loads(body), {
            "contractVersion": "tasq.hosted-mutation-request.v1",
            "resource": {"kind": "workspace", "id": "team/acme"},
            "expectedRevision": None,
            "input": {"title": "From Python"},
        })

    def test_retryable_problem_never_invents_success(self):
        self.transport.fail_next = True
        with self.assertRaises(TasqRemoteError) as raised:
            self.client.list_commitments()
        self.assertEqual(raised.exception.code, "authority_busy")
        self.assertTrue(raised.exception.retryable)

    def test_rejects_unsafe_endpoint_and_input_before_transport(self):
        with self.assertRaises(ValueError):
            TasqRemote(
                endpoint="http://public.example/",
                workspace_id="team/acme",
                access_token="token",
            )
        with self.assertRaises(ValueError):
            self.client.execute_operation(
                "../effect",
                resource={"kind": "workspace", "id": "team/acme"},
                input={},
                idempotency_key="key",
                request_id="request",
            )
        self.assertEqual(self.transport.calls, [])

    def test_client_has_no_kernel_or_database_dependency(self):
        source = Path(__file__).parents[1] / "tasq_remote" / "__init__.py"
        text = source.read_text()
        for forbidden in ("sqlite", "libsql", "tasq_core", "migrate", "drizzle"):
            self.assertNotIn(forbidden, text.lower())


if __name__ == "__main__":
    unittest.main()
