"""National risk model: LightGBM Poisson on direct deaths per event.

  python ml/train_risk.py

Validation
  - GroupKFold (5 folds) by state: can the model predict states it never saw?
  - time split: train <= 2019, test >= 2020
Outputs
  ml/exports/model_metrics.json (key "risk"), shap_summary.json, county_risk.json
  ml/figures/shap_*.png, ml/work/risk_model.txt
"""
import lightgbm as lgb
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import polars as pl
import shap
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import GroupKFold

from common import (EXPORTS, FEATURE_LABELS, FIGURES, PROCESSED, RISK_FEATURES, TIME_SPLIT_YEAR, WORK,
                    load_model_frame, to_numpy, update_metrics, write_json)

SEED = 7
PARAMS = {
    "objective": "poisson",
    "learning_rate": 0.03,
    "num_leaves": 15,
    "min_data_in_leaf": 100,  # deaths are rare; keep leaves big so they are not fit to single storms
    "feature_fraction": 0.8,
    "bagging_fraction": 0.8,
    "bagging_freq": 1,
    "lambda_l2": 1.0,
    "verbose": -1,
    "seed": SEED,
}


def poisson_deviance(y, mu):
    mu = np.clip(mu, 1e-9, None)
    term = np.where(y > 0, y * np.log(np.where(y > 0, y, 1) / mu), 0.0)
    return float(2 * np.mean(term - (y - mu)))


def baseline_pred(train, test):
    """Null model: mean deaths per event for each event type, learned on train."""
    rates = train.group_by("is_tornado").agg(pl.col("deaths_direct").mean().alias("rate"))
    return test.join(rates, on="is_tornado", how="left")["rate"].to_numpy()


def evaluate(y, mu, mu_base, event_type=None):
    fatal = y > 0
    order = np.argsort(-mu)
    out = {
        "n_events": int(len(y)),
        "n_fatal_events": int(fatal.sum()),
        "deaths_actual": int(y.sum()),
        "deaths_predicted": round(float(mu.sum()), 1),
        "poisson_deviance": round(poisson_deviance(y, mu), 5),
        "poisson_deviance_baseline": round(poisson_deviance(y, mu_base), 5),
        "auc_fatal": round(float(roc_auc_score(fatal, mu)), 4) if 0 < fatal.sum() < len(y) else None,
    }
    out["deviance_explained"] = round(1 - out["poisson_deviance"] / out["poisson_deviance_baseline"], 4)
    for pct in (1, 5, 10):
        k = max(1, int(len(y) * pct / 100))
        top = order[:k]
        out[f"recall_fatal_top{pct}pct"] = round(float(fatal[top].sum() / max(fatal.sum(), 1)), 4)
        out[f"share_deaths_top{pct}pct"] = round(float(y[top].sum() / max(y.sum(), 1)), 4)
    return out


def calibration_table(y, mu, n_bins=10):
    ranks = np.argsort(np.argsort(mu))
    decile = (ranks * n_bins // len(mu)) + 1
    rows = []
    for d in range(1, n_bins + 1):
        m = decile == d
        rows.append({
            "decile": d,
            "n_events": int(m.sum()),
            "mean_predicted": float(mu[m].mean()),
            "predicted_deaths": round(float(mu[m].sum()), 1),
            "actual_deaths": int(y[m].sum()),
            "fatal_events": int((y[m] > 0).sum()),
        })
    return rows


def fit(X, y, rounds):
    return lgb.train(PARAMS, lgb.Dataset(X, y, free_raw_data=False), num_boost_round=rounds)


def pick_rounds(df):
    """Number of boosting rounds from grouped CV on pre-test years only."""
    train = df.filter(pl.col("year") < TIME_SPLIT_YEAR)
    X, y = to_numpy(train, RISK_FEATURES), train["deaths_direct"].to_numpy()
    folds = list(GroupKFold(5).split(X, y, train["state"].to_numpy()))
    res = lgb.cv(PARAMS, lgb.Dataset(X, y), num_boost_round=2000, folds=folds,
                 callbacks=[lgb.early_stopping(100, verbose=False)], stratified=False)
    key = [k for k in res if k.endswith("-mean")][0]
    rounds = int(np.argmin(res[key]) + 1)
    print(f"  rounds from grouped CV on <{TIME_SPLIT_YEAR}: {rounds} ({key} {min(res[key]):.5f})")
    return rounds


def run_validation(df, rounds):
    X, y = to_numpy(df, RISK_FEATURES), df["deaths_direct"].to_numpy()
    results = {"group_kfold_by_state": [], "rounds": rounds}

    for i, (tr, te) in enumerate(GroupKFold(5).split(X, y, df["state"].to_numpy())):
        model = fit(X[tr], y[tr], rounds)
        mu = model.predict(X[te])
        base = baseline_pred(df[tr], df[te])
        r = evaluate(y[te], mu, base)
        r["fold"] = i + 1
        r["test_states"] = sorted(df[te]["state"].unique().to_list())
        results["group_kfold_by_state"].append(r)
        print(f"  fold {i + 1}: dev {r['poisson_deviance']:.4f} vs base {r['poisson_deviance_baseline']:.4f}"
              f"  explained {r['deviance_explained']:.1%}  auc {r['auc_fatal']}  top5% recall {r['recall_fatal_top5pct']:.1%}")

    tr = (df["year"] < TIME_SPLIT_YEAR).to_numpy()
    te = ~tr
    model = fit(X[tr], y[tr], rounds)
    mu = model.predict(X[te])
    base = baseline_pred(df.filter(pl.Series(tr)), df.filter(pl.Series(te)))
    ts = evaluate(y[te], mu, base)
    ts["train_deviance"] = round(poisson_deviance(y[tr], model.predict(X[tr])), 5)
    ts["calibration_by_decile"] = calibration_table(y[te], mu)
    test = df.filter(pl.Series(te))
    ts["by_event_type"] = {}
    for name, flag in [("Tornado", 1), ("Flash Flood", 0)]:
        m = (test["is_tornado"] == flag).to_numpy()
        ts["by_event_type"][name] = evaluate(y[te][m], mu[m], base[m])
    # the July 2025 Texas Hill Country flood rows dominate test deaths; show metrics without them too
    big = y[te] >= 40
    ts["without_events_40plus_deaths"] = evaluate(y[te][~big], mu[~big], base[~big])
    ts["events_40plus_deaths"] = [
        {"year": int(r["year"]), "state": r["state"], "event_type": r["event_type"],
         "deaths": int(r["deaths_direct"]), "predicted": round(float(p), 2)}
        for r, p in zip(test.filter(pl.Series(big)).iter_rows(named=True), mu[big])
    ]
    results["time_split"] = ts
    print(f"  time split: dev {ts['poisson_deviance']:.4f} vs base {ts['poisson_deviance_baseline']:.4f}"
          f"  explained {ts['deviance_explained']:.1%}  auc {ts['auc_fatal']}  train dev {ts['train_deviance']:.4f}")
    return results


def shap_outputs(model, df):
    FIGURES.mkdir(parents=True, exist_ok=True)
    sample = df.sample(30000, seed=SEED)
    X = sample.select(RISK_FEATURES).cast(pl.Float64).to_pandas()
    X.columns = [FEATURE_LABELS[c] for c in RISK_FEATURES]
    sv = shap.TreeExplainer(model).shap_values(X)

    shap.summary_plot(sv, X, show=False, max_display=len(RISK_FEATURES))
    plt.title("What drives predicted deaths (SHAP, log scale)")
    plt.tight_layout()
    plt.savefig(FIGURES / "shap_summary.png", dpi=150)
    plt.close()

    dependence = {}
    for feat in ["hour", "ef_rating", "mh_share"]:
        label = FEATURE_LABELS[feat]
        shap.dependence_plot(label, sv, X, interaction_index=FEATURE_LABELS["is_tornado"], show=False)
        plt.tight_layout()
        plt.savefig(FIGURES / f"shap_dependence_{feat}.png", dpi=150)
        plt.close()

        col = sample[feat].to_numpy().astype(float)
        vals = sv[:, RISK_FEATURES.index(feat)]
        ok = ~np.isnan(col)
        if feat == "mh_share":
            edges = np.quantile(col[ok], np.linspace(0, 1, 11))
            bins = np.clip(np.digitize(col[ok], edges[1:-1]), 0, 9)
            keys = [f"{edges[i]:.3f}-{edges[i + 1]:.3f}" for i in range(10)]
        else:
            bins = col[ok].astype(int)
            keys = sorted(set(bins.tolist()))
        pts = []
        for i, k in enumerate(keys):
            m = bins == (i if feat == "mh_share" else k)
            if m.sum() >= 20:
                pts.append({"x": k, "mean_shap": float(vals[ok][m].mean()),
                            "relative_risk": float(np.exp(vals[ok][m].mean())), "n": int(m.sum())})
        dependence[feat] = pts

    mean_abs = np.abs(sv).mean(axis=0)
    order = np.argsort(-mean_abs)
    summary = {
        "note": "Mean absolute SHAP value on the log of expected deaths. relative_risk = exp(mean SHAP) vs the average event.",
        "sample_size": len(sample),
        "importance": [{"feature": RISK_FEATURES[i], "label": FEATURE_LABELS[RISK_FEATURES[i]],
                        "mean_abs_shap": float(mean_abs[i])} for i in order],
        "dependence": dependence,
    }
    write_json(EXPORTS / "shap_summary.json", summary)


def county_risk(df, rounds):
    """Per county: expected deaths per decade over its own 1996-2025 events, plus predicted deaths for a
    fixed reference storm so counties compare on vulnerability alone.
    Every number comes from a model that never saw the county's state (GroupKFold by state): county
    features act like a fingerprint, so an in-sample model partly memorizes past disasters."""
    cf = pl.read_parquet(PROCESSED / "county_features.parquet").with_columns(
        log_pop_density=pl.col("pop_density").log1p(),
        state_fips=pl.col("county_fips").str.slice(0, 2).cast(pl.Int32),
    ).filter(pl.col("state_fips").is_in(df["state_fips"].unique().to_list()))
    n_years = df["year"].max() - df["year"].min() + 1

    def reference(frame, tornado, hour):
        return frame.with_columns(
            is_tornado=pl.lit(tornado), ef_rating=pl.lit(2 if tornado else None, pl.Float64),
            tor_length_mi=pl.lit(5.0 if tornado else None, pl.Float64),
            tor_width_yd=pl.lit(200.0 if tornado else None, pl.Float64),
            hour=pl.lit(hour), month=pl.lit(4 if tornado else 7),
        )

    X, y = to_numpy(df, RISK_FEATURES), df["deaths_direct"].to_numpy()
    oof = np.zeros(len(y))
    parts = []
    for tr, te in GroupKFold(5).split(X, y, df["state"].to_numpy()):
        m = fit(X[tr], y[tr], rounds)
        oof[te] = m.predict(X[te])
        held = cf.filter(pl.col("state_fips").is_in(df[te]["state_fips"].unique().to_list()))
        parts.append(held.select("county_fips", "state", "county").with_columns(
            ref_tornado_night=pl.Series(m.predict(to_numpy(reference(held, 1, 2), RISK_FEATURES))),
            ref_tornado_day=pl.Series(m.predict(to_numpy(reference(held, 1, 15), RISK_FEATURES))),
            ref_flood_night=pl.Series(m.predict(to_numpy(reference(held, 0, 2), RISK_FEATURES))),
        ))

    hist = df.with_columns(pred=pl.Series(oof)).group_by("county_fips").agg(
        tornado_events=(pl.col("is_tornado") == 1).sum(),
        flood_events=(pl.col("is_tornado") == 0).sum(),
        deaths_actual=pl.col("deaths_direct").sum(),
        expected_deaths=pl.col("pred").sum(),
    )
    out = pl.concat(parts).join(hist, on="county_fips", how="left").fill_null(0).with_columns(
        expected_deaths_per_decade=pl.col("expected_deaths") * 10 / n_years,
    ).sort("county_fips")
    fields = ["name", "expected_deaths_per_decade", "deaths_1996_2025", "tornado_events", "flood_events",
              "ref_tornado_night", "ref_tornado_day", "ref_flood_night"]
    rows = {r["county_fips"]: [
        f"{r['county']}, {r['state']}", round(r["expected_deaths_per_decade"], 3), int(r["deaths_actual"]),
        int(r["tornado_events"]), int(r["flood_events"]), round(r["ref_tornado_night"], 4),
        round(r["ref_tornado_day"], 4), round(r["ref_flood_night"], 4),
    ] for r in out.iter_rows(named=True)}
    write_json(EXPORTS / "county_risk.json", {
        "note": ("expected_deaths_per_decade: model-predicted direct deaths from the county's own 1996-2025 tornado "
                 "and flash flood events, per 10 years. ref_*: predicted deaths for the same reference storm in every "
                 "county (EF2 tornado, 5 mi x 200 yd, April; flash flood in July), so counties compare on vulnerability. "
                 "All values are out-of-fold: predicted by a model that never saw the county's state."),
        "fields": fields,
        "counties": rows,
    }, compact=True)


def main():
    df = load_model_frame()
    print(f"model frame: {df.height:,} events, {(df['deaths_direct'] > 0).sum():,} fatal")
    rounds = pick_rounds(df)
    results = run_validation(df, rounds)
    results["features"] = RISK_FEATURES
    results["params"] = PARAMS

    model = fit(to_numpy(df, RISK_FEATURES), df["deaths_direct"].to_numpy(), rounds)
    WORK.mkdir(parents=True, exist_ok=True)
    model.save_model(str(WORK / "risk_model.txt"))
    update_metrics("risk", results)
    shap_outputs(model, df)
    county_risk(df, rounds)


if __name__ == "__main__":
    main()
