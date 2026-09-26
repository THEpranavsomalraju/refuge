"""Shared paths, loaders and feature lists for the models."""
import json
from pathlib import Path

import numpy as np
import polars as pl

ROOT = Path(__file__).resolve().parents[1]
PROCESSED = ROOT / "data" / "processed"
EXPORTS = ROOT / "ml" / "exports"
FIGURES = ROOT / "ml" / "figures"
WORK = ROOT / "ml" / "work"  # gitignored: models, caches

FOCUS_TYPES = ["Tornado", "Flash Flood"]
LOCATION_CLASSES = ["MH", "RES", "PUBLIC", "VEHICLE", "WATER", "OUTDOOR", "OTHER"]
TIME_SPLIT_YEAR = 2020  # train <= 2019, test >= 2020

# 50 states + DC. Territories have no SVI county rows, so they stay out of the models.
STATE_FIPS_US = [f for f in range(1, 57) if f not in (3, 7, 14, 43, 52)]

RISK_FEATURES = [
    "is_tornado",
    "ef_rating",
    "tor_length_mi",
    "tor_width_yd",
    "hour",
    "month",
    "mh_share",
    "age65_share",
    "noveh_share",
    "log_pop_density",
    "svi",
]

FEATURE_LABELS = {
    "is_tornado": "Tornado (vs flash flood)",
    "ef_rating": "EF rating",
    "tor_length_mi": "Path length (mi)",
    "tor_width_yd": "Path width (yd)",
    "hour": "Hour of day",
    "month": "Month",
    "mh_share": "Mobile home share",
    "age65_share": "Share age 65+",
    "noveh_share": "No-vehicle households",
    "log_pop_density": "Population density (log)",
    "svi": "Social Vulnerability Index",
}


def load_model_frame():
    """Tornado + flash flood events in the 50 states + DC, joined to county features."""
    ev = pl.read_parquet(PROCESSED / "events.parquet")
    cf = pl.read_parquet(PROCESSED / "county_features.parquet")
    df = (
        ev.filter(pl.col("event_type").is_in(FOCUS_TYPES) & pl.col("state_fips").is_in(STATE_FIPS_US))
        .join(cf.select("county_fips", "mh_share", "age65_share", "noveh_share", "pop_density", "svi"),
              on="county_fips", how="left")
        .with_columns(
            is_tornado=(pl.col("event_type") == "Tornado").cast(pl.Int8),
            log_pop_density=pl.col("pop_density").log1p(),
            # widths/lengths only exist for tornadoes; a 0 width is "not recorded"
            tor_width_yd=pl.when(pl.col("tor_width_yd") > 0).then(pl.col("tor_width_yd")),
            tor_length_mi=pl.when(pl.col("tor_length_mi") > 0).then(pl.col("tor_length_mi")),
        )
    )
    return df


def to_numpy(df, cols):
    return df.select(cols).cast(pl.Float64).to_numpy()


def write_json(path, obj, compact=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    opts = {"separators": (",", ":")} if compact else {"indent": 1}
    path.write_text(json.dumps(obj, default=_json_default, **opts))
    print(f"  wrote {path.relative_to(ROOT)}  {path.stat().st_size / 1e3:.1f} KB")


def _json_default(o):
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating,)):
        return None if np.isnan(o) else round(float(o), 6)
    raise TypeError(type(o))


def update_metrics(section, payload):
    """model_metrics.json is shared by several scripts; each owns one top level key."""
    path = EXPORTS / "model_metrics.json"
    data = json.loads(path.read_text()) if path.exists() else {}
    data[section] = payload
    write_json(path, data)
