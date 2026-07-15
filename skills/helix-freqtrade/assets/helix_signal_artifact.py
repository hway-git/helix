"""Validation and indexing for immutable Helix Signal Artifacts.

This module intentionally contains no trading rules. It is shared by the
Freqtrade adapter and its contract tests so Python only consumes decisions
already made by the Helix Engine.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any


SCHEMA_VERSION = "helix.signal-artifact/v1"
PAYLOAD_FIELDS = (
    "schemaVersion",
    "identity",
    "strategyLifecycle",
    "objectModel",
    "symbol",
    "baseTimeframe",
    "marketData",
    "signals",
)
ARTIFACT_FIELDS = (*PAYLOAD_FIELDS, "artifactHash")
IDENTITY_FIELDS = (
    "strategyId",
    "strategyVersion",
    "strategyRepoCommit",
    "strategyConfigHash",
    "engineCommit",
    "marketDataSnapshotId",
)
SIGNAL_FIELDS = (
    "sequence",
    "signalId",
    "decisionId",
    "object",
    "action",
    "side",
    "sourceCandleOpenTime",
    "decisionTime",
    "reasonCodes",
)
LIFECYCLES = {"proposal", "backtested", "shadow", "canary", "production", "deprecated"}
OBJECT_MODELS = {"PRICE_EVENT", "TRADE_THESIS"}
ACTIONS = {"ENTER", "EXIT"}
SIDES = {"LONG", "SHORT"}
HASH_PATTERN = re.compile(r"^sha256:[a-f0-9]{64}$")
COMMIT_PATTERN = re.compile(r"^[a-f0-9]{40}(?:[a-f0-9]{24})?$")
REASON_CODE_PATTERN = re.compile(r"^[A-Z][A-Z0-9_]*$")
TIMEFRAME_PATTERN = re.compile(r"^(\d+)([mhdw])$")
TIMEFRAME_UNITS_MS = {"m": 60_000, "h": 3_600_000, "d": 86_400_000, "w": 604_800_000}


class SignalArtifactError(ValueError):
    pass


def _exact_record(value: Any, name: str, fields: tuple[str, ...]) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise SignalArtifactError(f"{name} must be an object")
    if set(value) != set(fields):
        raise SignalArtifactError(f"{name} must contain exactly: {', '.join(fields)}")
    return value


def _text(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        raise SignalArtifactError(f"{name} must be a non-empty trimmed string")
    return value


def _integer(value: Any, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0 or value > 9_007_199_254_740_991:
        raise SignalArtifactError(f"{name} must be a non-negative safe integer")
    return value


def _timeframe_milliseconds(value: Any) -> tuple[str, int]:
    timeframe = _text(value, "baseTimeframe")
    match = TIMEFRAME_PATTERN.fullmatch(timeframe)
    if not match or int(match.group(1)) < 1:
        raise SignalArtifactError("baseTimeframe must use Freqtrade minute, hour, day, or week syntax")
    duration = int(match.group(1)) * TIMEFRAME_UNITS_MS[match.group(2)]
    if duration > 9_007_199_254_740_991:
        raise SignalArtifactError("baseTimeframe duration is too large")
    return timeframe, duration


def _canonical_json(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, int) and not isinstance(value, bool):
        _integer(value, "canonical number")
        return str(value)
    if isinstance(value, list):
        return "[" + ",".join(_canonical_json(item) for item in value) + "]"
    if isinstance(value, dict):
        entries = (
            json.dumps(key, ensure_ascii=False, separators=(",", ":")) + ":" + _canonical_json(value[key])
            for key in sorted(value)
        )
        return "{" + ",".join(entries) + "}"
    raise SignalArtifactError(f"unsupported canonical JSON value {type(value).__name__}")


def artifact_hash(payload: dict[str, Any]) -> str:
    canonical = _canonical_json(payload).encode("utf-8")
    return "sha256:" + hashlib.sha256(canonical).hexdigest()


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise SignalArtifactError(f"duplicate JSON key {key}")
        result[key] = value
    return result


def validate_artifact(value: Any) -> dict[str, Any]:
    artifact = _exact_record(value, "signal artifact", ARTIFACT_FIELDS)
    if artifact["schemaVersion"] != SCHEMA_VERSION:
        raise SignalArtifactError(f"unsupported signal artifact schema {artifact['schemaVersion']}")

    identity = _exact_record(artifact["identity"], "identity", IDENTITY_FIELDS)
    for field in IDENTITY_FIELDS:
        _text(identity[field], f"identity.{field}")
    if not COMMIT_PATTERN.fullmatch(identity["strategyRepoCommit"]):
        raise SignalArtifactError("identity.strategyRepoCommit must be a full Git commit")
    if not HASH_PATTERN.fullmatch(identity["strategyConfigHash"]):
        raise SignalArtifactError("identity.strategyConfigHash must be a SHA-256 hash")
    if not COMMIT_PATTERN.fullmatch(identity["engineCommit"]):
        raise SignalArtifactError("identity.engineCommit must be a full Git commit")

    lifecycle = _text(artifact["strategyLifecycle"], "strategyLifecycle")
    if lifecycle not in LIFECYCLES:
        raise SignalArtifactError("strategyLifecycle is invalid")
    object_model = _text(artifact["objectModel"], "objectModel")
    if object_model not in OBJECT_MODELS:
        raise SignalArtifactError("objectModel is invalid")
    symbol = _text(artifact["symbol"], "symbol")
    if any(character.isspace() for character in symbol):
        raise SignalArtifactError("symbol must not contain whitespace")
    _, timeframe_ms = _timeframe_milliseconds(artifact["baseTimeframe"])

    market_data = _exact_record(
        artifact["marketData"],
        "marketData",
        ("firstCandleOpenTime", "lastCandleCloseTime"),
    )
    first_open = _integer(market_data["firstCandleOpenTime"], "marketData.firstCandleOpenTime")
    last_close = _integer(market_data["lastCandleCloseTime"], "marketData.lastCandleCloseTime")
    if first_open % timeframe_ms or last_close % timeframe_ms:
        raise SignalArtifactError("marketData boundaries must align to baseTimeframe")
    if last_close <= first_open:
        raise SignalArtifactError("marketData.lastCandleCloseTime must follow firstCandleOpenTime")

    signals = artifact["signals"]
    if not isinstance(signals, list):
        raise SignalArtifactError("signals must be an array")
    signal_ids: set[str] = set()
    decision_ids: set[str] = set()
    decision_times: set[int] = set()
    open_position: tuple[str, str] | None = None
    prior_decision_time = -1
    for index, raw_signal in enumerate(signals):
        name = f"signals[{index}]"
        signal = _exact_record(raw_signal, name, SIGNAL_FIELDS)
        sequence = _integer(signal["sequence"], f"{name}.sequence")
        if sequence != index:
            raise SignalArtifactError(f"{name}.sequence must equal {index}")
        signal_id = _text(signal["signalId"], f"{name}.signalId")
        decision_id = _text(signal["decisionId"], f"{name}.decisionId")
        reference = _exact_record(signal["object"], f"{name}.object", ("model", "id"))
        if reference["model"] != object_model:
            raise SignalArtifactError(f"{name}.object.model must match artifact objectModel")
        object_id = _text(reference["id"], f"{name}.object.id")
        action = _text(signal["action"], f"{name}.action")
        side = _text(signal["side"], f"{name}.side")
        if action not in ACTIONS:
            raise SignalArtifactError(f"{name}.action is invalid")
        if side not in SIDES:
            raise SignalArtifactError(f"{name}.side is invalid")
        source_open = _integer(signal["sourceCandleOpenTime"], f"{name}.sourceCandleOpenTime")
        decision_time = _integer(signal["decisionTime"], f"{name}.decisionTime")
        if source_open % timeframe_ms:
            raise SignalArtifactError(f"{name}.sourceCandleOpenTime must align to baseTimeframe")
        if decision_time != source_open + timeframe_ms:
            raise SignalArtifactError(f"{name}.decisionTime must equal the source candle close time")
        if decision_time < prior_decision_time:
            raise SignalArtifactError("signals must be ordered by decisionTime")
        if source_open < first_open or decision_time > last_close:
            raise SignalArtifactError(f"{name} falls outside the marketData window")
        if signal_id in signal_ids:
            raise SignalArtifactError(f"duplicate signalId {signal_id}")
        if decision_id in decision_ids:
            raise SignalArtifactError(f"duplicate decisionId {decision_id}")
        if decision_time in decision_times:
            raise SignalArtifactError(f"multiple signals at decisionTime {decision_time} are ambiguous")
        if action == "ENTER":
            if open_position:
                raise SignalArtifactError(
                    f"ENTER for object {object_id} overlaps open position for object {open_position[0]}"
                )
            open_position = (object_id, side)
        else:
            if not open_position:
                raise SignalArtifactError(f"EXIT for object {object_id} has no matching ENTER")
            if open_position[0] != object_id:
                raise SignalArtifactError(
                    f"EXIT for object {object_id} does not match open ENTER for object {open_position[0]}"
                )
            if open_position[1] != side:
                raise SignalArtifactError(f"EXIT side for object {object_id} does not match its ENTER")
            open_position = None
        reason_codes = signal["reasonCodes"]
        if not isinstance(reason_codes, list) or not reason_codes:
            raise SignalArtifactError(f"{name}.reasonCodes must be a non-empty array")
        normalized_reason_codes = [_text(code, f"{name}.reasonCodes") for code in reason_codes]
        if len(set(normalized_reason_codes)) != len(normalized_reason_codes):
            raise SignalArtifactError(f"{name}.reasonCodes must not contain duplicates")
        if any(not REASON_CODE_PATTERN.fullmatch(code) for code in normalized_reason_codes):
            raise SignalArtifactError(f"{name}.reasonCodes contains an invalid reason code")
        signal_ids.add(signal_id)
        decision_ids.add(decision_id)
        decision_times.add(decision_time)
        prior_decision_time = decision_time

    actual_hash = _text(artifact["artifactHash"], "artifactHash")
    if not HASH_PATTERN.fullmatch(actual_hash):
        raise SignalArtifactError("artifactHash must be a SHA-256 hash")
    payload = {field: artifact[field] for field in PAYLOAD_FIELDS}
    expected_hash = artifact_hash(payload)
    if actual_hash != expected_hash:
        raise SignalArtifactError(f"signal artifact hash mismatch: expected {expected_hash}")
    return artifact


def load_artifact(path: str | Path) -> dict[str, Any]:
    artifact_path = Path(path)
    try:
        payload = json.loads(artifact_path.read_text(encoding="utf-8"), object_pairs_hook=_reject_duplicate_keys)
    except (OSError, json.JSONDecodeError) as error:
        raise SignalArtifactError(f"cannot read signal artifact {artifact_path}: {error}") from error
    return validate_artifact(payload)


def load_artifacts(path: str | Path) -> list[dict[str, Any]]:
    artifact_path = Path(path)
    if not artifact_path.exists():
        return []
    files = [artifact_path] if artifact_path.is_file() else sorted(artifact_path.glob("*.json"))
    artifacts = [load_artifact(file) for file in files]
    if not artifacts:
        return []
    pinned_fields = ("strategyId", "strategyVersion", "strategyRepoCommit", "strategyConfigHash", "engineCommit")
    expected_identity = artifacts[0]["identity"]
    expected_runtime = (
        artifacts[0]["strategyLifecycle"],
        artifacts[0]["objectModel"],
        artifacts[0]["baseTimeframe"],
    )
    for artifact in artifacts[1:]:
        if any(artifact["identity"][field] != expected_identity[field] for field in pinned_fields):
            raise SignalArtifactError("artifact directory mixes incompatible strategy identities")
        if (artifact["strategyLifecycle"], artifact["objectModel"], artifact["baseTimeframe"]) != expected_runtime:
            raise SignalArtifactError("artifact directory mixes incompatible runtime contracts")
    return artifacts


def signals_for(
    artifacts: list[dict[str, Any]],
    symbol: str,
    timeframe: str,
) -> dict[tuple[str, str], dict[int, str]]:
    result: dict[tuple[str, str], dict[int, str]] = {
        (action, side): {} for action in ACTIONS for side in SIDES
    }
    seen_signal_ids: set[str] = set()
    for artifact in artifacts:
        if artifact["symbol"] != symbol or artifact["baseTimeframe"] != timeframe:
            continue
        for signal in artifact["signals"]:
            if signal["signalId"] in seen_signal_ids:
                raise SignalArtifactError(f"duplicate queued signalId {signal['signalId']}")
            key = (signal["action"], signal["side"])
            open_time = signal["sourceCandleOpenTime"]
            if open_time in result[key]:
                raise SignalArtifactError(
                    f"duplicate queued {signal['action']} {signal['side']} signal at {signal['decisionTime']}"
                )
            result[key][open_time] = signal["signalId"]
            seen_signal_ids.add(signal["signalId"])
    return result


def path_fingerprint(path: str | Path) -> tuple[Any, ...]:
    artifact_path = Path(path)
    if not artifact_path.exists():
        return (str(artifact_path), "missing")
    files = [artifact_path] if artifact_path.is_file() else sorted(artifact_path.glob("*.json"))
    return tuple((str(file), file.stat().st_mtime_ns, file.stat().st_size) for file in files)


def _main() -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Verify or inspect Helix Signal Artifacts")
    parser.add_argument("action", choices=("verify", "signals"))
    parser.add_argument("path")
    parser.add_argument("symbol", nargs="?")
    parser.add_argument("timeframe", nargs="?")
    args = parser.parse_args()
    artifacts = load_artifacts(args.path)
    if args.action == "verify":
        print(json.dumps({
            "ok": True,
            "artifacts": len(artifacts),
            "hashes": [artifact["artifactHash"] for artifact in artifacts],
        }, separators=(",", ":")))
        return 0
    if not args.symbol or not args.timeframe:
        parser.error("signals requires symbol and timeframe")
    indexed = signals_for(artifacts, args.symbol, args.timeframe)
    rows = [
        {"action": action, "side": side, "sourceCandleOpenTime": open_time, "signalId": signal_id}
        for (action, side), signals in sorted(indexed.items())
        for open_time, signal_id in sorted(signals.items())
    ]
    print(json.dumps(rows, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(_main())
    except SignalArtifactError as error:
        raise SystemExit(str(error)) from error
