"""Category groups, categories, and drag-reorder."""

from flask import Blueprint, jsonify, request, abort

import db
from api.auth import require_auth
from api.common import next_sort

categories_bp = Blueprint("categories", __name__)


@categories_bp.route("/api/categories")
@require_auth
def api_categories():
    """Full category tree (for editing screens & pickers)."""
    conn = db.get_db()
    try:
        groups = []
        for g in conn.execute(
                "SELECT * FROM category_groups ORDER BY sort_order, name"):
            cats = [dict(c) for c in conn.execute(
                "SELECT * FROM categories WHERE group_id=? ORDER BY sort_order, name",
                (g["id"],))]
            gd = dict(g)
            gd["categories"] = cats
            groups.append(gd)
        return jsonify(groups)
    finally:
        conn.close()


@categories_bp.route("/api/groups", methods=["POST"])
@require_auth
def api_create_group():
    name = ((request.json or {}).get("name") or "").strip()
    if not name:
        abort(400, "Name required")
    conn = db.get_db()
    try:
        so = next_sort(conn, "category_groups")
        cur = conn.execute(
            "INSERT INTO category_groups (name, sort_order) VALUES (?, ?)",
            (name, so))
        conn.commit()
        return jsonify({"id": cur.lastrowid})
    finally:
        conn.close()


@categories_bp.route("/api/groups/<int:gid>", methods=["PUT"])
@require_auth
def api_update_group(gid):
    p = request.json or {}
    conn = db.get_db()
    try:
        g = conn.execute("SELECT * FROM category_groups WHERE id=?", (gid,)).fetchone()
        if not g:
            abort(404)
        if g["is_income"]:
            abort(400, "System group cannot be renamed")
        conn.execute("UPDATE category_groups SET name=?, hidden=? WHERE id=?",
                     ((p.get("name") or g["name"]).strip(),
                      int(p.get("hidden", g["hidden"])), gid))
        conn.commit()
        return jsonify({"ok": True})
    finally:
        conn.close()


@categories_bp.route("/api/groups/<int:gid>", methods=["DELETE"])
@require_auth
def api_delete_group(gid):
    conn = db.get_db()
    try:
        g = conn.execute("SELECT * FROM category_groups WHERE id=?", (gid,)).fetchone()
        if not g:
            abort(404)
        if g["is_income"]:
            abort(400, "System group cannot be deleted")
        # Un-categorize anything (transactions AND split lines) in this group's
        # categories, and drop their budget/carryover rows, so nothing is left
        # pointing at a category that's about to disappear.
        members = "(SELECT id FROM categories WHERE group_id=?)"
        conn.execute(f"UPDATE transactions SET category_id=NULL WHERE category_id IN {members}", (gid,))
        conn.execute(f"UPDATE transaction_splits SET category_id=NULL WHERE category_id IN {members}", (gid,))
        conn.execute(f"DELETE FROM budgets WHERE category_id IN {members}", (gid,))
        conn.execute(f"DELETE FROM carryover WHERE category_id IN {members}", (gid,))
        conn.execute("DELETE FROM categories WHERE group_id=?", (gid,))
        conn.execute("DELETE FROM category_groups WHERE id=?", (gid,))
        conn.commit()
        return jsonify({"ok": True})
    finally:
        conn.close()


@categories_bp.route("/api/categories", methods=["POST"])
@require_auth
def api_create_category():
    p = request.json or {}
    name = (p.get("name") or "").strip()
    gid = p.get("group_id")
    if not name or not gid:
        abort(400, "Name and group required")
    conn = db.get_db()
    try:
        g = conn.execute("SELECT * FROM category_groups WHERE id=?", (gid,)).fetchone()
        if not g or g["is_income"]:
            abort(400, "Cannot add categories to this group")
        so = next_sort(conn, "categories", "WHERE group_id=?", (gid,))
        cur = conn.execute(
            "INSERT INTO categories (group_id, name, sort_order) VALUES (?, ?, ?)",
            (gid, name, so))
        conn.commit()
        return jsonify({"id": cur.lastrowid})
    finally:
        conn.close()


@categories_bp.route("/api/categories/<int:cid>", methods=["PUT"])
@require_auth
def api_update_category(cid):
    p = request.json or {}
    conn = db.get_db()
    try:
        c = conn.execute("SELECT * FROM categories WHERE id=?", (cid,)).fetchone()
        if not c:
            abort(404)
        if c["is_income"]:
            abort(400, "System category cannot be edited")
        name = (p.get("name") or c["name"]).strip()
        gid = p.get("group_id", c["group_id"])
        # Don't let a normal category be moved into the Inflow group — that
        # would corrupt the budget computation, which treats income specially.
        if gid != c["group_id"]:
            tg = conn.execute("SELECT is_income FROM category_groups "
                              "WHERE id=?", (gid,)).fetchone()
            if not tg or tg["is_income"]:
                abort(400, "Invalid target group")
        hidden = int(p.get("hidden", c["hidden"]))
        conn.execute("UPDATE categories SET name=?, group_id=?, hidden=? WHERE id=?",
                     (name, gid, hidden, cid))
        conn.commit()
        return jsonify({"ok": True})
    finally:
        conn.close()


@categories_bp.route("/api/categories/<int:cid>", methods=["DELETE"])
@require_auth
def api_delete_category(cid):
    conn = db.get_db()
    try:
        c = conn.execute("SELECT * FROM categories WHERE id=?", (cid,)).fetchone()
        if not c:
            abort(404)
        if c["is_income"]:
            abort(400, "System category cannot be deleted")
        conn.execute("UPDATE transactions SET category_id=NULL WHERE category_id=?",
                     (cid,))
        # Split lines and carryover events reference the category too — clear
        # them so the delete doesn't leave orphaned rows pointing at it.
        conn.execute("UPDATE transaction_splits SET category_id=NULL WHERE category_id=?",
                     (cid,))
        conn.execute("DELETE FROM budgets WHERE category_id=?", (cid,))
        conn.execute("DELETE FROM carryover WHERE category_id=?", (cid,))
        conn.execute("DELETE FROM categories WHERE id=?", (cid,))
        conn.commit()
        return jsonify({"ok": True})
    finally:
        conn.close()


@categories_bp.route("/api/reorder", methods=["POST"])
@require_auth
def api_reorder():
    """Persist drag-reorder. Body: {type:'group'|'category'|'account', ids:[...]}"""
    p = request.json or {}
    table = {"group": "category_groups", "category": "categories",
             "account": "accounts"}.get(p.get("type"))
    ids = p.get("ids") or []
    if not table:
        abort(400)
    conn = db.get_db()
    try:
        for i, _id in enumerate(ids):
            conn.execute(f"UPDATE {table} SET sort_order=? WHERE id=?", (i, _id))
        conn.commit()
        return jsonify({"ok": True})
    finally:
        conn.close()
