"""Freqtrade execution adapter for Helix Signal Artifacts.

Strategy decisions belong to the Helix Engine. This adapter validates the
immutable artifact and maps its exact closed-candle timestamps to Freqtrade's
entry and exit columns. It must not contain indicators or strategy rules.
"""

from __future__ import annotations

import os
from pathlib import Path

from pandas import DataFrame
from freqtrade.strategy import IStrategy

from helix_signal_artifact import load_artifacts, path_fingerprint, signals_for


class HelixSignalStrategy(IStrategy):
    INTERFACE_VERSION = 3

    timeframe = os.environ.get("HELIX_SIGNAL_TIMEFRAME", "").strip() or "1m"
    can_short = True
    process_only_new_candles = True
    startup_candle_count = 0

    minimal_roi = {"0": 100.0}
    stoploss = -0.99
    trailing_stop = False
    use_exit_signal = True
    exit_profit_only = False
    ignore_roi_if_entry_signal = True

    _helix_artifact_fingerprint = None
    _helix_artifacts = None

    def _artifact_path(self) -> Path:
        configured = os.environ.get("HELIX_SIGNAL_ARTIFACT_PATH", "").strip()
        if configured:
            return Path(configured)
        user_data_dir = Path(self.config.get("user_data_dir", "."))
        return user_data_dir / "helix" / "signals" / "active.json"

    def _signal_index(self, pair: str):
        artifact_path = self._artifact_path()
        fingerprint = path_fingerprint(artifact_path)
        if fingerprint != self._helix_artifact_fingerprint:
            self._helix_artifacts = load_artifacts(artifact_path)
            self._helix_artifact_fingerprint = fingerprint
        return signals_for(self._helix_artifacts or [], pair, self.timeframe)

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
