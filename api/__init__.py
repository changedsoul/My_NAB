"""API blueprints for My NAB, split by domain.

Each submodule owns one slice of the REST API and exposes a Flask blueprint.
`register_blueprints(app)` wires them all onto the application.
"""


def register_blueprints(app):
    from api.auth import auth_bp
    from api.accounts import accounts_bp
    from api.categories import categories_bp
    from api.budget import budget_bp
    from api.budgets import budgets_bp
    from api.transactions import transactions_bp
    from api.reports import reports_bp
    from api.imports import imports_bp
    from api.scheduled import scheduled_bp
    from api.calendar_feed import calendar_bp
    from api.system import system_bp
    from api.security import security_bp
    from api.memory import memory_bp
    from api.devices import devices_bp
    from api.ping import ping_bp
    from api.frontend import frontend_bp
    for bp in (auth_bp, accounts_bp, categories_bp, budget_bp, budgets_bp,
               transactions_bp, reports_bp, imports_bp, scheduled_bp,
               calendar_bp, system_bp, security_bp, memory_bp, devices_bp, ping_bp, frontend_bp):
        app.register_blueprint(bp)
