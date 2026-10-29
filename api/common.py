"""Small query helpers shared across several blueprints."""


def next_sort(conn, table, where="", params=()):
    q = f"SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM {table} {where}"
    return conn.execute(q, params).fetchone()["n"]


def account_balance(conn, account_id):
    row = conn.execute(
        "SELECT COALESCE(SUM(amount),0) AS bal, "
        "COALESCE(SUM(CASE WHEN cleared>0 THEN amount ELSE 0 END),0) AS cleared "
        "FROM transactions WHERE account_id=?", (account_id,)).fetchone()
    return row["bal"], row["cleared"]
