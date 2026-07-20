"""Freqtrade execution adapter for Helix Signal Artifacts.

Strategy decisions belong to the Helix Engine. This adapter validates the
immutable artifact and maps its exact closed-candle timestamps to Freqtrade's
entry and exit columns. It must not contain indicators or strategy rules.
"""

from __future__ import annotations

import os
import hashlib
import json
import math
from pathlib import Path

from pandas import DataFrame
from freqtrade.strategy import IStrategy

from helix_signal_artifact import SignalArtifactError, load_artifacts, path_fingerprint, signals_for
from helix_signal_batch import (
    batch_path_fingerprint,
    load_batch_chain,
    require_worker_heartbeat,
    risk_intents_for_batches,
    signals_for_batches,
    validate_risk_intent,
)


class HelixSignalStrategy(IStrategy):
    INTERFACE_VERSION = 3

    timeframe = os.environ.get("HELIX_SIGNAL_TIMEFRAME", "").strip() or "1m"
    can_short = True
    # Forward batches may arrive after Freqtrade first processes a candle close.
    process_only_new_candles = False
    startup_candle_count = 0

    minimal_roi = {"0": 100.0}
    stoploss = -0.99
    trailing_stop = False
    use_exit_signal = True
    exit_profit_only = False
    ignore_roi_if_entry_signal = True

    _helix_artifact_fingerprint = None
    _helix_artifacts = None
    _helix_batch_fingerprint = None
    _helix_batches = None
    _helix_historical_risk_fingerprint = None
    _helix_historical_risks = None
    _helix_stake_headroom = 1.01

    def _leverage_cache(self):
        cache = getattr(self, "_helix_leverage_by_entry", None)
        if cache is None:
            cache = {}
            self._helix_leverage_by_entry = cache
        return cache

    def _artifact_path(self) -> Path:
        environment_path = os.environ.get("HELIX_SIGNAL_ARTIFACT_PATH", "").strip()
        if self._artifact_override_enabled():
            if not environment_path:
                raise SignalArtifactError("HELIX_SIGNAL_ARTIFACT_OVERRIDE requires HELIX_SIGNAL_ARTIFACT_PATH")
            return Path(environment_path)
        configured = str(self.config.get("helix_signal_artifact_path", "")).strip()
        if not configured:
            configured = environment_path
        if configured:
            return Path(configured)
        user_data_dir = Path(self.config.get("user_data_dir", "."))
        return user_data_dir / "helix" / "signals" / "active.json"

    @staticmethod
    def _artifact_override_enabled() -> bool:
        return os.environ.get("HELIX_SIGNAL_ARTIFACT_OVERRIDE", "").strip() == "1"

    def _load_pinned_artifacts(self):
        artifact_path = self._artifact_path()
        fingerprint = path_fingerprint(artifact_path)
        if fingerprint != self._helix_artifact_fingerprint:
            self._helix_artifacts = load_artifacts(artifact_path)
            self._helix_artifact_fingerprint = fingerprint
        expected_hash = (
            os.environ.get("HELIX_SIGNAL_ARTIFACT_HASH", "").strip()
            if self._artifact_override_enabled()
            else str(self.config.get("helix_signal_artifact_hash", "")).strip()
        )
        if self._artifact_override_enabled() and not expected_hash:
            raise SignalArtifactError("artifact override requires HELIX_SIGNAL_ARTIFACT_HASH")
        if expected_hash and (
            len(self._helix_artifacts or []) != 1
            or self._helix_artifacts[0]["artifactHash"] != expected_hash
        ):
            raise SignalArtifactError(
                f"configured signal artifact hash {expected_hash} does not match {artifact_path}"
            )
        return self._helix_artifacts or []

    def _forward_paths(self) -> tuple[Path, Path, Path] | None:
        if self._artifact_override_enabled():
            return None
        deployment = str(self.config.get("helix_signal_forward_deployment_path", "")).strip()
        batches = str(self.config.get("helix_signal_batch_path", "")).strip()
        status = str(self.config.get("helix_signal_forward_status_path", "")).strip()
        if not deployment and not batches and not status:
            return None
        if not deployment or not batches or not status:
            raise SignalArtifactError("forward Signal mode requires deployment, batch, and status paths")
        return Path(deployment), Path(batches), Path(status)

    def _load_pinned_batches(self):
        paths = self._forward_paths()
        if not paths:
            return None
        deployment_path, batches_path, _status_path = paths
        fingerprint = batch_path_fingerprint(deployment_path, batches_path)
        if fingerprint != self._helix_batch_fingerprint:
            deployment, batches = load_batch_chain(deployment_path, batches_path)
            expected_hash = str(self.config.get("helix_signal_forward_deployment_hash", "")).strip()
            if not expected_hash or deployment["deploymentHash"] != expected_hash:
                raise SignalArtifactError("configured forward deployment hash does not match its file")
            self._helix_batches = batches
            self._helix_batch_fingerprint = fingerprint
        return self._helix_batches or []

    def _load_historical_risks(self):
        risk_path = os.environ.get("HELIX_SIGNAL_RISK_TRACE_PATH", "").strip()
        expected_file_hash = os.environ.get("HELIX_SIGNAL_RISK_TRACE_FILE_HASH", "").strip()
        expected_trace_hash = os.environ.get("HELIX_SIGNAL_RISK_TRACE_HASH", "").strip()
        risk_unit_ratio_text = os.environ.get("HELIX_SIGNAL_RISK_UNIT_RATIO", "").strip()
        if not risk_path or not expected_file_hash or not expected_trace_hash or not risk_unit_ratio_text:
            raise SignalArtifactError("historical Signal mode requires a pinned risk trace and risk unit ratio")
        path = Path(risk_path)
        try:
            stat = path.stat()
            fingerprint = (
                str(path.resolve()), stat.st_ino, stat.st_ctime_ns, stat.st_mtime_ns, stat.st_size,
                expected_file_hash, expected_trace_hash, risk_unit_ratio_text,
            )
        except OSError as error:
            raise SignalArtifactError(f"cannot stat historical risk trace {path}: {error}") from error
        if fingerprint == self._helix_historical_risk_fingerprint:
            return self._helix_historical_risks or {}
        try:
            content = path.read_bytes()
            actual_file_hash = "sha256:" + hashlib.sha256(content).hexdigest()
            if actual_file_hash != expected_file_hash:
                raise SignalArtifactError("historical risk trace file hash does not match its pin")
            trace = json.loads(content)
        except (OSError, json.JSONDecodeError) as error:
            raise SignalArtifactError(f"cannot read historical risk trace {path}: {error}") from error
        if not isinstance(trace, dict) or set(trace) != {"schemaVersion", "signalArtifactHash", "entries", "traceHash"}:
            raise SignalArtifactError("historical risk trace envelope is invalid")
        if trace["schemaVersion"] != "helix.historical-risk-trace/v1" or trace["traceHash"] != expected_trace_hash:
            raise SignalArtifactError("historical risk trace contract hash does not match its pin")
        artifacts = self._load_pinned_artifacts()
        if len(artifacts) != 1 or trace["signalArtifactHash"] != artifacts[0]["artifactHash"]:
            raise SignalArtifactError("historical risk trace does not match the pinned Signal Artifact")
        try:
            risk_unit_ratio = float(risk_unit_ratio_text)
        except ValueError as error:
            raise SignalArtifactError("HELIX_SIGNAL_RISK_UNIT_RATIO must be numeric") from error
        if not math.isfinite(risk_unit_ratio) or risk_unit_ratio <= 0 or risk_unit_ratio > 1:
            raise SignalArtifactError("HELIX_SIGNAL_RISK_UNIT_RATIO must be in (0, 1]")
        enter_signals = [signal for signal in artifacts[0]["signals"] if signal["action"] == "ENTER"]
        entries = trace["entries"]
        if not isinstance(entries, list) or len(entries) != len(enter_signals):
            raise SignalArtifactError("historical risk trace must cover every Artifact ENTER exactly once")
        risks = {}
        for index, (entry, signal) in enumerate(zip(entries, enter_signals)):
            if not isinstance(entry, dict):
                raise SignalArtifactError(f"historical risk entries[{index}] must be an object")
            if entry.get("entrySignalId") != signal["signalId"] or entry.get("object") != signal["object"] \
                    or entry.get("side") != signal["side"]:
                raise SignalArtifactError(f"historical risk entries[{index}] does not match its Artifact ENTER")
            entry_price = entry.get("entryPrice")
            if not isinstance(entry_price, dict) or set(entry_price) != {"source", "price"} \
                    or entry_price.get("source") != "DECISION_CANDLE_CLOSE":
                raise SignalArtifactError(f"historical risk entries[{index}].entryPrice is invalid")
            intent = {
                "entryPrice": entry_price["price"],
                "initialStop": entry.get("initialStop"),
                "initialTarget": entry.get("initialTarget"),
                "riskDistance": entry.get("riskDistance"),
                "riskR": entry.get("riskR"),
                "riskUnitRatio": risk_unit_ratio,
            }
            validate_risk_intent(intent, "ENTER", signal["side"])
            risks[signal["signalId"]] = {"side": signal["side"], "riskIntent": intent}
        self._helix_historical_risks = risks
        self._helix_historical_risk_fingerprint = fingerprint
        return risks

    def _risk_index(self, pair: str):
        batches = self._load_pinned_batches()
        if batches is not None:
            return risk_intents_for_batches(batches, pair, self.timeframe)
        return self._load_historical_risks()

    def _require_forward_health(self) -> None:
        paths = self._forward_paths()
        if not paths:
            return
        expected_hash = str(self.config.get("helix_signal_forward_deployment_hash", "")).strip()
        if not expected_hash:
            raise SignalArtifactError("forward Signal mode requires a configured deployment hash")
        require_worker_heartbeat(paths[2], expected_hash)

    def bot_start(self, **kwargs) -> None:
        if self._forward_paths():
            self._load_pinned_batches()
        else:
            self._load_pinned_artifacts()
            self._load_historical_risks()

    def _signal_index(self, pair: str):
        batches = self._load_pinned_batches()
        if batches is not None:
            return signals_for_batches(batches, pair, self.timeframe)
        return signals_for(self._load_pinned_artifacts(), pair, self.timeframe)

    def confirm_trade_entry(
        self, pair, order_type, amount, rate, time_in_force, current_time,
        entry_tag, side, **kwargs,
    ) -> bool:
        try:
            self._require_forward_health()
            risk_index = self._risk_index(pair)
            if entry_tag not in risk_index:
                return False
            # Freqtrade may fall back to max_stake when custom_stake_amount
            # cannot fit the requested risk budget. Reject that under-sized
            # entry instead of silently recording less than the intended R.
            if not isinstance(amount, (int, float)) or not math.isfinite(amount) \
                    or not isinstance(rate, (int, float)) or not math.isfinite(rate):
                return True
            risk, equity, _price_risk_ratio, total_risk_ratio = self._risk_context(
                pair, rate, entry_tag, side
            )
            leverage = kwargs.get("leverage")
            if not isinstance(leverage, (int, float)) or not math.isfinite(leverage) or leverage < 1:
                leverage = self._leverage_cache().get((pair, entry_tag, side))
            if not isinstance(leverage, (int, float)) or not math.isfinite(leverage) or leverage < 1:
                return False
            expected_budget = equity * float(risk["riskUnitRatio"]) * float(risk["riskR"])
            actual_budget = float(amount) * float(rate) * total_risk_ratio
            tolerance = max(1e-8, expected_budget * 0.025)
            return actual_budget <= expected_budget + 1e-8 \
                and actual_budget >= expected_budget - tolerance
        except (SignalArtifactError, ValueError):
            return False

    def _risk_context(self, pair, current_rate, entry_tag, side):
        if not isinstance(current_rate, (int, float)) or not math.isfinite(current_rate) or current_rate <= 0:
            raise SignalArtifactError("current rate must be finite and positive")
        expected_side = "LONG" if side == "long" else "SHORT" if side == "short" else None
        if expected_side is None:
            raise SignalArtifactError("entry side is invalid")
        risk_record = self._risk_index(pair).get(entry_tag)
        if not risk_record or risk_record["side"] != expected_side:
            raise SignalArtifactError("entry tag has no matching risk intent")
        risk = validate_risk_intent(risk_record["riskIntent"], "ENTER", expected_side)
        initial_stop = float(risk["initialStop"])
        if expected_side == "LONG" and initial_stop >= current_rate:
            raise SignalArtifactError("LONG stop must be below the current rate")
        if expected_side == "SHORT" and initial_stop <= current_rate:
            raise SignalArtifactError("SHORT stop must be above the current rate")
        price_risk_ratio = abs(current_rate - initial_stop) / current_rate
        if not math.isfinite(price_risk_ratio) or price_risk_ratio <= 0:
            raise SignalArtifactError("price risk ratio is invalid")
        configured_fee = self.config.get("fee")
        if not isinstance(configured_fee, (int, float)) or not math.isfinite(configured_fee) \
                or configured_fee < 0:
            raise SignalArtifactError("Signal risk sizing requires an explicit non-negative fee")
        stop_rate_ratio = initial_stop / current_rate
        total_risk_ratio = price_risk_ratio + float(configured_fee) \
            + stop_rate_ratio * float(configured_fee)
        if not math.isfinite(total_risk_ratio) or total_risk_ratio <= 0:
            raise SignalArtifactError("fee-inclusive risk ratio is invalid")
        stake_currency = str(self.config.get("stake_currency", "")).strip()
        equity = float(self.wallets.get_total(stake_currency))
        if not math.isfinite(equity) or equity <= 0:
            raise SignalArtifactError("wallet equity is invalid")
        return risk, equity, price_risk_ratio, total_risk_ratio

    def leverage(
        self, pair, current_time, current_rate, proposed_leverage, max_leverage, entry_tag, side, **kwargs,
    ) -> float:
        try:
            if not isinstance(max_leverage, (int, float)) or not math.isfinite(max_leverage) or max_leverage < 1:
                return 1.0
            risk, equity, _price_risk_ratio, total_risk_ratio = self._risk_context(
                pair, current_rate, entry_tag, side
            )
            tradable_ratio = float(self.config.get("tradable_balance_ratio", 1.0))
            if not math.isfinite(tradable_ratio) or tradable_ratio <= 0 or tradable_ratio > 1:
                return 1.0
            stake_currency = str(self.config.get("stake_currency", "")).strip()
            available_stake = equity * tradable_ratio
            get_available = getattr(self.wallets, "get_available_stake_amount", None)
            get_free = getattr(self.wallets, "get_free", None)
            wallet_available = (
                float(get_available()) if callable(get_available)
                else float(get_free(stake_currency)) if callable(get_free)
                else available_stake
            )
            if math.isfinite(wallet_available) and wallet_available > 0:
                available_stake = min(available_stake, wallet_available)
            risk_budget = equity * float(risk["riskUnitRatio"]) * float(risk["riskR"])
            required_at_one_x = risk_budget / total_risk_ratio
            required_leverage = (required_at_one_x / available_stake) * self._helix_stake_headroom
            selected = max(1.0, required_leverage)
            selected = math.ceil(selected * 100) / 100
            selected = min(float(max_leverage), selected)
            self._leverage_cache()[(pair, entry_tag, side)] = selected
            return selected
        except (AttributeError, KeyError, SignalArtifactError, TypeError, ValueError):
            self._leverage_cache()[(pair, entry_tag, side)] = 1.0
            return 1.0

    def custom_stake_amount(
        self, pair, current_time, current_rate, proposed_stake, min_stake,
        max_stake, leverage, entry_tag, side, **kwargs,
    ) -> float:
        try:
            if not isinstance(leverage, (int, float)) or not math.isfinite(leverage) or leverage < 1:
                return 0.0
            risk, equity, _price_risk_ratio, total_risk_ratio = self._risk_context(
                pair, current_rate, entry_tag, side
            )
            risk_budget = equity * float(risk["riskUnitRatio"]) * float(risk["riskR"])
            stake_amount = risk_budget / (total_risk_ratio * float(leverage))
            if not math.isfinite(stake_amount) or stake_amount <= 0:
                return 0.0
            if min_stake is not None and stake_amount < float(min_stake):
                return 0.0
            if max_stake is None or not math.isfinite(float(max_stake)) or stake_amount > float(max_stake):
                return 0.0
            return stake_amount
        except (AttributeError, KeyError, SignalArtifactError, TypeError, ValueError):
            return 0.0

    def custom_exit(
        self, pair, trade, current_time, current_rate, current_profit, **kwargs,
    ):
        try:
            self._require_forward_health()
            return None
        except (SignalArtifactError, ValueError):
            return "helix_forward_unavailable"

    @staticmethod
    def _apply_signal_column(
        dataframe: DataFrame,
        signals: dict[int, str],
        signal_column: str,
        tag_column: str,
    ) -> None:
        dataframe[signal_column] = 0
        if not signals or dataframe.empty:
            return
        candle_open_ms = (
            dataframe["date"]
            .astype("datetime64[ns, UTC]")
            .astype("int64")
            // 1_000_000
        )
        tags = candle_open_ms.map(signals)
        matched = tags.notna()
        dataframe.loc[matched, signal_column] = 1
        dataframe.loc[matched, tag_column] = tags.loc[matched]

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        if not self._artifact_override_enabled():
            return dataframe
        # Freqtrade clamps exit limits to candle bounds before exchange precision
        # rounding, then requires the rounded float to remain inside those bounds.
        # Preserve the exchange-price envelope across that float-only boundary.
        dataframe["low"] = dataframe["low"].map(
            lambda value: math.nextafter(float(value), -math.inf)
        )
        dataframe["high"] = dataframe["high"].map(
            lambda value: math.nextafter(float(value), math.inf)
        )
        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        index = self._signal_index(metadata["pair"])
        dataframe["enter_tag"] = None
        self._apply_signal_column(dataframe, index[("ENTER", "LONG")], "enter_long", "enter_tag")
        self._apply_signal_column(dataframe, index[("ENTER", "SHORT")], "enter_short", "enter_tag")
        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        index = self._signal_index(metadata["pair"])
        dataframe["exit_tag"] = None
        self._apply_signal_column(dataframe, index[("EXIT", "LONG")], "exit_long", "exit_tag")
        self._apply_signal_column(dataframe, index[("EXIT", "SHORT")], "exit_short", "exit_tag")
        return dataframe
