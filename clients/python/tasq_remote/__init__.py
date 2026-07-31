"""Thin, dependency-free Tasq Server client.

The server owns validation, migrations, authorization and domain semantics.
This module only constructs the frozen HTTP envelopes and validates their
top-level identities.
"""

from __future__ import annotations

import json
import re
import ssl
import uuid
from dataclasses import dataclass
from typing import Any, Callable, Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit, urlunsplit
from urllib.request import Request, urlopen

__all__ = [
    "TasqRemote",
    "TasqRemoteError",
    "redeem_remote_enrollment",
    "__version__",
]
__version__ = "0.1.0"

_WORKSPACE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$")
_OPERATION = re.compile(r"^[a-z][a-z0-9._-]{0,99}$")
_RESOURCE_KINDS = {"workspace", "commitment", "resource", "effect", "replica"}
_MAX_BODY = 8 * 1024 * 1024

Transport = Callable[
    [str, str, Mapping[str, str], bytes | None],
    tuple[int, Mapping[str, str], bytes],
]


@dataclass(frozen=True)
class TasqRemoteError(Exception):
    status: int
    code: str
    request_id: str | None
    retryable: bool
    oldest_sequence: int | None = None

    def __str__(self) -> str:
        return f"{self.code} ({self.status})"


def _endpoint(value: str) -> str:
    parsed = urlsplit(value)
    loopback = parsed.hostname in {"127.0.0.1", "localhost", "::1"}
    if (
        parsed.scheme not in ({"https"} | ({"http"} if loopback else set()))
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("endpoint must be canonical HTTPS; HTTP is loopback-only")
    path = parsed.path or "/"
    if not path.endswith("/"):
        path += "/"
    return urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))


def _default_transport(
    method: str,
    url: str,
    headers: Mapping[str, str],
    body: bytes | None,
) -> tuple[int, Mapping[str, str], bytes]:
    request = Request(url, data=body, headers=dict(headers), method=method)
    try:
        with urlopen(request, timeout=30, context=ssl.create_default_context()) as response:
            return response.status, dict(response.headers.items()), response.read(_MAX_BODY + 1)
    except HTTPError as error:
        return error.code, dict(error.headers.items()), error.read(_MAX_BODY + 1)
    except URLError as error:
        raise TasqRemoteError(0, "network_error", headers.get("x-tasq-request-id"), True) from error


def _json(body: bytes, status: int, request_id: str) -> dict[str, Any]:
    if len(body) > _MAX_BODY:
        raise TasqRemoteError(status, "response_too_large", request_id, False)
    try:
        value = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise TasqRemoteError(status, "invalid_server_response", request_id, status >= 500) from error
    if not isinstance(value, dict):
        raise TasqRemoteError(status, "invalid_server_response", request_id, status >= 500)
    return value


def _problem(
    value: Mapping[str, Any], status: int, request_id: str
) -> TasqRemoteError:
    code = value.get("code")
    server_request_id = value.get("requestId")
    oldest = value.get("oldestSequence")
    return TasqRemoteError(
        status,
        code if isinstance(code, str) else "invalid_server_response",
        server_request_id if isinstance(server_request_id, str) else request_id,
        status >= 500 or code in {"authority_busy", "mutation_outcome_unknown"},
        oldest if isinstance(oldest, int) and oldest >= 0 else None,
    )


def redeem_remote_enrollment(
    *,
    endpoint: str,
    workspace_id: str,
    enrollment_token: str,
    transport: Transport | None = None,
    request_id: str | None = None,
) -> dict[str, Any]:
    """Redeem one pre-provisioned enrollment without inventing identity."""
    if not _WORKSPACE.fullmatch(workspace_id):
        raise ValueError("invalid workspace_id")
    if (
        not isinstance(enrollment_token, str)
        or not 32 <= len(enrollment_token) <= 2_000
    ):
        raise ValueError("enrollment_token must contain 32..2000 characters")
    rid = request_id or str(uuid.uuid4())
    if not isinstance(rid, str) or not rid or len(rid) > 500:
        raise ValueError("request_id must contain 1..500 characters")
    target = (
        _endpoint(endpoint)
        + "v1/workspaces/"
        + quote(workspace_id, safe="")
        + "/enrollments/redeem"
    )
    headers = {
        "accept": "application/json",
        "content-type": "application/json",
        "x-tasq-request-id": rid,
    }
    body = json.dumps(
        {
            "contractVersion": "tasq.remote-enrollment.v1",
            "enrollmentToken": enrollment_token,
        },
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    sender = transport or _default_transport
    try:
        status, _, response_body = sender("POST", target, headers, body)
    except TasqRemoteError:
        raise
    except Exception as error:
        raise TasqRemoteError(0, "network_error", rid, True) from error
    value = _json(response_body, status, rid)
    if not 200 <= status < 300:
        raise _problem(value, status, rid)
    if (
        value.get("contractVersion") != "tasq.remote-enrollment.v1"
        or value.get("workspaceId") != workspace_id
        or not isinstance(value.get("accessToken"), str)
        or not 32 <= len(value["accessToken"]) <= 2_000
    ):
        raise TasqRemoteError(status, "invalid_server_response", rid, False)
    return value


class TasqRemote:
    contract_version = "tasq.remote-python-client.v1"

    def __init__(
        self,
        *,
        endpoint: str,
        workspace_id: str,
        access_token: str | Callable[[], str],
        transport: Transport | None = None,
        request_id_factory: Callable[[], str] | None = None,
    ) -> None:
        if not _WORKSPACE.fullmatch(workspace_id):
            raise ValueError("invalid workspace_id")
        self.endpoint = _endpoint(endpoint)
        self.workspace_id = workspace_id
        self._access_token = access_token
        self._transport = transport or _default_transport
        self._request_id_factory = request_id_factory or (lambda: str(uuid.uuid4()))
        encoded = quote(workspace_id, safe="")
        self._workspace_path = f"v1/workspaces/{encoded}"

    def _token(self) -> str:
        value = self._access_token() if callable(self._access_token) else self._access_token
        if not isinstance(value, str) or not value or len(value) > 32_000:
            raise ValueError("access token must contain 1..32000 characters")
        return value

    def _request(
        self,
        method: str,
        path: str,
        *,
        body: dict[str, Any] | None = None,
        request_id: str | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> dict[str, Any]:
        rid = request_id or self._request_id_factory()
        if not isinstance(rid, str) or not rid or len(rid) > 500:
            raise ValueError("request_id must contain 1..500 characters")
        token = self._token()
        headers = {
            "accept": "application/json",
            "authorization": token if token.startswith("Bearer ") else f"Bearer {token}",
            "x-tasq-request-id": rid,
        }
        payload = None
        if body is not None:
            headers["content-type"] = "application/json"
            payload = json.dumps(
                body, ensure_ascii=False, separators=(",", ":"), allow_nan=False
            ).encode("utf-8")
        if extra_headers:
            headers.update(extra_headers)
        try:
            status, _, response_body = self._transport(
                method, self.endpoint + path, headers, payload
            )
        except TasqRemoteError:
            raise
        except Exception as error:
            raise TasqRemoteError(0, "network_error", rid, True) from error
        value = _json(response_body, status, rid)
        if not 200 <= status < 300:
            raise _problem(value, status, rid)
        return value

    def list_commitments(
        self, *, cursor: str | None = None, limit: int | None = None
    ) -> dict[str, Any]:
        query: dict[str, str] = {}
        if cursor is not None:
            if not cursor or len(cursor) > 2_000:
                raise ValueError("cursor must contain 1..2000 characters")
            query["cursor"] = cursor
        if limit is not None:
            if not isinstance(limit, int) or not 1 <= limit <= 100:
                raise ValueError("limit must be 1..100")
            query["limit"] = str(limit)
        suffix = "?" + urlencode(query) if query else ""
        value = self._request("GET", f"{self._workspace_path}/commitments{suffix}")
        if value.get("contractVersion") != "tasq.hosted-commitment-page.v1":
            raise TasqRemoteError(200, "invalid_server_response", None, False)
        return value

    def get_commitment(self, commitment_id: str) -> dict[str, Any]:
        if not commitment_id or len(commitment_id) > 500:
            raise ValueError("invalid commitment_id")
        value = self._request(
            "GET",
            f"{self._workspace_path}/commitments/{quote(commitment_id, safe='')}",
        )
        if value.get("contractVersion") != "tasq.hosted-commitment.v1":
            raise TasqRemoteError(200, "invalid_server_response", None, False)
        return value

    def list_events(
        self, *, after_sequence: int = 0, limit: int | None = None
    ) -> dict[str, Any]:
        if not isinstance(after_sequence, int) or after_sequence < 0:
            raise ValueError("after_sequence must be a non-negative integer")
        query = {"after": str(after_sequence)}
        if limit is not None:
            if not isinstance(limit, int) or not 1 <= limit <= 100:
                raise ValueError("limit must be 1..100")
            query["limit"] = str(limit)
        value = self._request(
            "GET", f"{self._workspace_path}/events?{urlencode(query)}"
        )
        if value.get("contractVersion") != "tasq.hosted-event-metadata-page.v1":
            raise TasqRemoteError(200, "invalid_server_response", None, False)
        return value

    def list_operations(self) -> dict[str, Any]:
        value = self._request("GET", "v1/operations")
        if value.get("contractVersion") != "tasq.hosted-operation-catalog.v1":
            raise TasqRemoteError(200, "invalid_server_response", None, False)
        return value

    def execute_operation(
        self,
        operation_id: str,
        *,
        resource: Mapping[str, str],
        input: Any,
        idempotency_key: str,
        request_id: str,
        expected_revision: int | None = None,
    ) -> dict[str, Any]:
        if not _OPERATION.fullmatch(operation_id):
            raise ValueError("invalid operation_id")
        kind, resource_id = resource.get("kind"), resource.get("id")
        if kind not in _RESOURCE_KINDS or not resource_id or len(resource_id) > 500:
            raise ValueError("invalid resource")
        if not idempotency_key or len(idempotency_key) > 500:
            raise ValueError("idempotency_key must contain 1..500 characters")
        if expected_revision is not None and (
            not isinstance(expected_revision, int) or expected_revision < 1
        ):
            raise ValueError("expected_revision must be a positive integer or None")
        value = self._request(
            "POST",
            f"{self._workspace_path}/operations/{operation_id}",
            request_id=request_id,
            extra_headers={"idempotency-key": idempotency_key},
            body={
                "contractVersion": "tasq.hosted-mutation-request.v1",
                "resource": {"kind": kind, "id": resource_id},
                "expectedRevision": expected_revision,
                "input": input,
            },
        )
        if value.get("contractVersion") != "tasq.hosted-mutation-response.v1":
            raise TasqRemoteError(200, "invalid_server_response", None, False)
        outcome = value.get("outcome")
        if not isinstance(outcome, dict):
            raise TasqRemoteError(200, "invalid_server_response", None, False)
        return outcome
