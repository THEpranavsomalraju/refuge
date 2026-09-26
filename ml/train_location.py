"""Location model: given a fatal event, predict the share of deaths by location class.

  python ml/train_location.py

Multinomial logistic regression. One row per direct death with a known location, carrying
its event and county features. Each event gets total weight 1 (weight = 1 / deaths in event)
so a single huge storm like Joplin does not dominate the fit.

Baseline: national average shares per event type, learned on the training rows.
Validation: GroupKFold by state + time split (train <= 2019, test >= 2020).
Outputs: model_metrics.json (key "location"), ml/work/location_model.pkl
"""
import pickle

import numpy as np
import polars as pl
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import log_loss
from sklearn.model_selection import GroupKFold
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from common import LOCATION_CLASSES, PROCESSED, TIME_SPLIT_YEAR, WORK, load_model_frame, update_metrics

FEATURES = ["is_tornado", "ef_rating", "ef_missing", "log_length", "log_width", "hour_sin", "hour_cos", "is_night",
            "month_sin", "month_cos", "mh_share", "age65_share", "noveh_share", "log_pop_density", "svi"]
C = 0.5  # mild L2; ~4k deaths across 7 classes


def build_frame():
    ev = load_model_frame()
    fat = pl.read_parquet(PROCESSED / "fatalities.parquet").filter(
        (pl.col("fatality_type") == "D") & ~pl.col("location_unknown")
    ).select("event_id", "location_class")
    df = fat.join(ev, on="event_id", how="inner")
    df = df.with_columns(
        weight=1.0 / pl.len().over("event_id"),
        ef_missing=pl.col("ef_rating").is_null().cast(pl.Int8),
        ef_rating=pl.col("ef_rating").fill_null(0),
        log_length=pl.col("tor_length_mi").fill_null(0).log1p(),
        log_width=pl.col("tor_width_yd").fill_null(0).log1p(),
        hour_sin=(pl.col("hour") * 2 * np.pi / 24).sin(),
        hour_cos=(pl.col("hour") * 2 * np.pi / 24).cos(),
        is_night=pl.col("hour").is_in([20, 21, 22, 23, 0, 1, 2, 3, 4, 5]).cast(pl.Int8),
        month_sin=(pl.col("month") * 2 * np.pi / 12).sin(),
        month_cos=(pl.col("month") * 2 * np.pi / 12).cos(),
    )
    # county features missing for a handful of counties (CT etc.): fill with medians
    df = df.with_columns([pl.col(c).fill_null(pl.col(c).median()) for c in
                          ["mh_share", "age65_share", "noveh_share", "log_pop_density", "svi"]])
    return df


def xy(df):
    X = df.select(FEATURES).cast(pl.Float64).to_numpy()
    y = df["location_class"].replace_strict({c: i for i, c in enumerate(LOCATION_CLASSES)}).to_numpy()
    return X, y, df["weight"].to_numpy()


def model():
    return make_pipeline(StandardScaler(), LogisticRegression(C=C, max_iter=2000))


def full_proba(m, X):
    """predict_proba with a column for every class, even ones missing from a training fold."""
    p = np.full((len(X), len(LOCATION_CLASSES)), 1e-6)
    p[:, m[-1].classes_] = m.predict_proba(X)
    return p / p.sum(axis=1, keepdims=True)


def baseline_proba(train, test):
    shares = {}
    for t in [0, 1]:
        s = train.filter(pl.col("is_tornado") == t)
        w = s.group_by("location_class").agg(pl.col("weight").sum())
        d = dict(w.iter_rows())
        tot = sum(d.values())
        shares[t] = np.array([(d.get(c, 0) + 0.5) / (tot + 0.5 * len(LOCATION_CLASSES)) for c in LOCATION_CLASSES])
    return np.stack([shares[t] for t in test["is_tornado"].to_list()])


def score(train, test):
    Xtr, ytr, wtr = xy(train)
    Xte, yte, wte = xy(test)
    m = model().fit(Xtr, ytr, logisticregression__sample_weight=wtr)
    p, b = full_proba(m, Xte), baseline_proba(train, test)
    labels = list(range(len(LOCATION_CLASSES)))
    r = {
        "n_deaths": int(len(yte)), "n_events": int(test["event_id"].n_unique()),
        "log_loss_event_weighted": round(log_loss(yte, p, sample_weight=wte, labels=labels), 4),
        "log_loss_event_weighted_baseline": round(log_loss(yte, b, sample_weight=wte, labels=labels), 4),
        "log_loss_per_death": round(log_loss(yte, p, labels=labels), 4),
        "log_loss_per_death_baseline": round(log_loss(yte, b, labels=labels), 4),
    }
    r["improvement_event_weighted"] = round(1 - r["log_loss_event_weighted"] / r["log_loss_event_weighted_baseline"], 4)
    r["improvement_per_death"] = round(1 - r["log_loss_per_death"] / r["log_loss_per_death_baseline"], 4)
    return r


def main():
    df = build_frame()
    print(f"location frame: {df.height:,} deaths, {df['event_id'].n_unique():,} events")
    res = {"features": FEATURES, "C": C, "classes": LOCATION_CLASSES, "group_kfold_by_state": []}
    for i, (tr, te) in enumerate(GroupKFold(5).split(df, groups=df["state"].to_numpy())):
        r = score(df[tr], df[te])
        r["fold"] = i + 1
        res["group_kfold_by_state"].append(r)
        print(f"  fold {i + 1}: log loss {r['log_loss_event_weighted']:.3f} vs base {r['log_loss_event_weighted_baseline']:.3f}"
              f" ({r['improvement_event_weighted']:+.1%})   per death {r['log_loss_per_death']:.3f} vs {r['log_loss_per_death_baseline']:.3f}")
    ts = score(df.filter(pl.col("year") < TIME_SPLIT_YEAR), df.filter(pl.col("year") >= TIME_SPLIT_YEAR))
    res["time_split"] = ts
    print(f"  time split: log loss {ts['log_loss_event_weighted']:.3f} vs base {ts['log_loss_event_weighted_baseline']:.3f}"
          f" ({ts['improvement_event_weighted']:+.1%})   per death {ts['log_loss_per_death']:.3f} vs {ts['log_loss_per_death_baseline']:.3f}")

    X, y, w = xy(df)
    final = model().fit(X, y, logisticregression__sample_weight=w)
    WORK.mkdir(parents=True, exist_ok=True)
    with open(WORK / "location_model.pkl", "wb") as f:
        pickle.dump({"model": final, "features": FEATURES, "classes": LOCATION_CLASSES}, f)

    # example predicted mixes for the landing page / sanity
    med = {c: float(df[c].median()) for c in ["age65_share", "noveh_share", "log_pop_density", "svi"]}
    examples = {}
    for label, hour, mh in [("EF3 tornado, 2 AM, high mobile home county", 2, 0.25),
                            ("EF3 tornado, 3 PM, high mobile home county", 15, 0.25),
                            ("EF3 tornado, 3 PM, low mobile home county", 15, 0.03)]:
        row = {"is_tornado": 1, "ef_rating": 3, "ef_missing": 0, "log_length": np.log1p(10), "log_width": np.log1p(500),
               "hour_sin": np.sin(hour * 2 * np.pi / 24), "hour_cos": np.cos(hour * 2 * np.pi / 24),
               "is_night": int(hour < 6 or hour >= 20), "month_sin": np.sin(4 * 2 * np.pi / 12),
               "month_cos": np.cos(4 * 2 * np.pi / 12), "mh_share": mh, **med}
        p = full_proba(final, np.array([[row[f] for f in FEATURES]]))[0]
        examples[label] = {c: round(float(v), 3) for c, v in zip(LOCATION_CLASSES, p)}
        print(f"  {label}: " + ", ".join(f"{c} {v:.0%}" for c, v in examples[label].items()))
    res["examples"] = examples
    update_metrics("location", res)


if __name__ == "__main__":
    main()
