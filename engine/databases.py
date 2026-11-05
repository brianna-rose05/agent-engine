"""A durable Postgres database per project, inside the owner's one Postgres server (Neon). See docs/databases.md.

    url = provision_database(os.environ["POSTGRES_ADMIN_URL"], "studio-garden-ab12cd")
    # -> the admin URL with its database swapped for app_studio_garden_ab12cd (created if missing)

Idempotent: a retry, change or rollback finds the database already there and gets the same URL. Nothing is
ever dropped here. The app applies its own migrations on first use (templates/next-supabase/src/lib/migrate.ts).

Connection strings carry a password: they are never printed, and every error message is scrubbed
(`scrub`) before it leaves this module. psycopg (v3) is imported only when a database is provisioned.
"""
from __future__ import annotations

import hashlib
import re
import urllib.parse
from typing import Callable

PREFIX = "app_"
MAX_IDENT = 63                      # Postgres truncates identifiers longer than this (NAMEDATALEN - 1)
CONNECT_TIMEOUT_S = 20


class DatabaseError(Exception):
    """Provisioning failed. The message is already scrubbed of URLs and passwords."""


def database_name(project_slug: str) -> str:
    """app_<slug>: lowercase letters, digits and underscores, at most 63 characters. A name that would be cut
    short keeps a hash of the full slug, so two long slugs never share a database."""
    slug = re.sub(r"[^a-z0-9]+", "_", project_slug.lower()).strip("_") or "project"
    name = PREFIX + slug
    if len(name) <= MAX_IDENT:
        return name
    digest = hashlib.sha1(project_slug.encode()).hexdigest()[:8]
    return f"{name[:MAX_IDENT - 9].rstrip('_')}_{digest}"


def database_url(admin_url: str, name: str) -> str:
    """The admin URL with its database swapped for `name`: same user, password, host, port and query
    parameters (sslmode, channel_binding, options...)."""
    parts = urllib.parse.urlsplit(admin_url)
    if parts.scheme not in ("postgres", "postgresql") or not parts.hostname:
        raise DatabaseError("POSTGRES_ADMIN_URL is not a postgres:// connection string")
    if not re.fullmatch(r"[a-z0-9_]+", name):
        raise DatabaseError(f"bad database name {name!r}")
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, "/" + name, parts.query, parts.fragment))


URL_RE = re.compile(r"postgres(?:ql)?://\S+", re.IGNORECASE)


def scrub(text: str, *urls: str) -> str:
    """Removes connection strings and their passwords (raw and URL-decoded) from `text`."""
    for url in urls:
        if not url:
            continue
        text = text.replace(url, "***")
        try:
            password = urllib.parse.urlsplit(url).password
        except ValueError:
            password = None
        for secret in {password, urllib.parse.unquote(password or "")}:
            if secret:
                text = text.replace(secret, "***")
    return URL_RE.sub("postgresql://***", text)


def _psycopg_connect(url: str):
    import psycopg                                  # lazy: the engine imports without it
    return psycopg.connect(url, autocommit=True, connect_timeout=CONNECT_TIMEOUT_S)


def provision_database(admin_url: str, project_slug: str,
                       connect: Callable[[str], object] | None = None) -> str:
    """Creates database app_<slug> on the admin URL's server if it doesn't exist; returns its connection string.
    Raises DatabaseError (scrubbed) on any failure."""
    name = database_name(project_slug)
    url = database_url(admin_url, name)
    try:
        conn = (connect or _psycopg_connect)(admin_url)
        try:
            cur = conn.cursor()
            cur.execute("select 1 from pg_database where datname = %s", (name,))
            if cur.fetchone() is None:
                try:
                    # CREATE DATABASE takes no parameters; the name is [a-z0-9_] only (database_url checks it).
                    cur.execute(f'create database "{name}"')
                except Exception as e:              # another run created it in the meantime
                    if getattr(e, "sqlstate", None) != "42P04":
                        raise
        finally:
            conn.close()
    except DatabaseError:
        raise
    except Exception as e:
        raise DatabaseError(scrub(f"{type(e).__name__}: {e}", admin_url, url)[:300]) from None
    return url
