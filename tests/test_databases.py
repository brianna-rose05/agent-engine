"""Per-project Postgres databases (engine/databases.py). Never touches a real Neon account."""
import os
import shutil
import socket
import subprocess
import time
import urllib.parse

import pytest

from engine.databases import DatabaseError, database_name, database_url, provision_database, scrub

ADMIN = "postgresql://neondb_owner:s3cr%2Ft-pw@ep-cool-name-123456-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require"


def test_database_names_are_safe_identifiers():
    assert database_name("studio-garden-ab12cd") == "app_studio_garden_ab12cd"
    assert database_name("Studio Pawfect: Grooming!") == "app_studio_pawfect_grooming"
    assert database_name("---") == "app_project"
    assert database_name('x"; drop database neondb; --') == "app_x_drop_database_neondb"


def test_long_names_fit_postgres_and_stay_distinct():
    a, b = database_name("s" * 80 + "-a"), database_name("s" * 80 + "-b")
    assert len(a) <= 63 and len(b) <= 63 and a != b
    assert database_name("s" * 80 + "-a") == a                 # stable across runs


def test_url_keeps_credentials_host_and_query_and_swaps_the_database():
    url = database_url(ADMIN, "app_x")
    p, q = urllib.parse.urlsplit(url), urllib.parse.urlsplit(ADMIN)
    assert p.path == "/app_x"
    assert (p.scheme, p.netloc, p.query) == (q.scheme, q.netloc, q.query)
    assert database_url("postgres://u:p@h:5433", "app_y") == "postgres://u:p@h:5433/app_y"
    assert database_url("postgres://u:p@h/db?options=endpoint%3Dep-1", "app_y") == "postgres://u:p@h/app_y?options=endpoint%3Dep-1"


def test_bad_admin_urls_are_rejected_without_echoing_them():
    for bad in ("https://u:topsecret@h/db", "not a url", "postgresql:///db"):
        with pytest.raises(DatabaseError) as e:
            database_url(bad, "app_x")
        assert "topsecret" not in str(e.value)


def test_scrub_removes_urls_and_passwords_raw_and_decoded():
    msg = f"connection to {ADMIN} failed: password 's3cr/t-pw' (s3cr%2Ft-pw) rejected; also postgres://a:b@c/d"
    out = scrub(msg, ADMIN)
    assert "s3cr" not in out and "neondb_owner:" not in out and "a:b@c" not in out


class FakeConn:
    def __init__(self, existing=(), fail=None, race=False):
        self.existing, self.fail, self.race = set(existing), fail, race
        self.statements, self.closed = [], False

    def cursor(self):
        return self

    def execute(self, sql, params=None):
        self.statements.append((sql, params))
        if self.fail:
            raise self.fail
        if sql.startswith("create database"):
            if self.race:
                e = Exception("database already exists")
                e.sqlstate = "42P04"
                raise e
            self.existing.add(sql.split('"')[1])
        self.last = (sql, params)

    def fetchone(self):
        sql, params = self.last
        return (1,) if params and params[0] in self.existing else None

    def close(self):
        self.closed = True


def test_provision_creates_once_and_returns_the_project_url():
    conn = FakeConn()
    seen = []
    url = provision_database(ADMIN, "studio-garden-ab12cd", connect=lambda u: (seen.append(u), conn)[1])
    assert seen == [ADMIN]                                    # connects with the admin URL
    assert url == database_url(ADMIN, "app_studio_garden_ab12cd")
    assert [s for s, _ in conn.statements] == ["select 1 from pg_database where datname = %s",
                                               'create database "app_studio_garden_ab12cd"']
    assert conn.closed
    again = FakeConn(existing={"app_studio_garden_ab12cd"})
    assert provision_database(ADMIN, "studio-garden-ab12cd", connect=lambda u: again) == url
    assert not [s for s, _ in again.statements if s.startswith("create")]   # idempotent


def test_provision_tolerates_a_concurrent_create():
    assert provision_database(ADMIN, "p", connect=lambda u: FakeConn(race=True)).endswith("/app_p?sslmode=require&channel_binding=require")


def test_provision_errors_are_scrubbed():
    def boom(url):
        raise RuntimeError(f'connection failed: {url} password "s3cr/t-pw"')
    with pytest.raises(DatabaseError) as e:
        provision_database(ADMIN, "p", connect=boom)
    assert "s3cr" not in str(e.value) and "neon.tech" not in str(e.value)
    conn = FakeConn(fail=RuntimeError(f"permission denied to create database (url {ADMIN})"))
    with pytest.raises(DatabaseError) as e:
        provision_database(ADMIN, "p", connect=lambda u: conn)
    assert "permission denied" in str(e.value) and "s3cr" not in str(e.value) and conn.closed


def test_engine_imports_without_psycopg():
    out = subprocess.run(["python3", "-c", "import sys; sys.modules['psycopg'] = None; import engine.databases, worker"],
                         capture_output=True, text=True, cwd=os.path.dirname(os.path.dirname(__file__)))
    assert out.returncode == 0, out.stderr


# ------------------------------------------------------------------ a real Postgres, when one is available
def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def admin_url(tmp_path_factory):
    """TEST_POSTGRES_ADMIN_URL (a throwaway server, role with CREATEDB) or a temporary local cluster. Skips when
    neither is possible (no psycopg, no Postgres binaries, or running as root, which initdb refuses)."""
    pytest.importorskip("psycopg")
    if os.environ.get("TEST_POSTGRES_ADMIN_URL"):
        yield os.environ["TEST_POSTGRES_ADMIN_URL"]
        return
    dirs = [os.path.dirname(shutil.which("pg_ctl") or "")]
    if os.path.isdir("/usr/lib/postgresql"):                   # Debian/Ubuntu keep them off PATH
        dirs += sorted((f"/usr/lib/postgresql/{v}/bin" for v in os.listdir("/usr/lib/postgresql")), reverse=True)
    bindir = next((d for d in dirs if d and os.path.exists(f"{d}/initdb") and os.path.exists(f"{d}/pg_ctl")), None)
    if not bindir or os.geteuid() == 0:
        pytest.skip("no local Postgres to start (set TEST_POSTGRES_ADMIN_URL to run this test)")
    data = tmp_path_factory.mktemp("pg") / "data"
    port = _free_port()
    subprocess.run([f"{bindir}/initdb", "-D", str(data), "-A", "trust", "-U", "admin"], check=True, capture_output=True)
    subprocess.run([f"{bindir}/pg_ctl", "-D", str(data), "-o", f"-p {port} -k {data} -c listen_addresses=127.0.0.1",
                    "-l", str(data / "log"), "-w", "start"], check=True, capture_output=True)
    try:
        yield f"postgresql://admin@127.0.0.1:{port}/postgres?sslmode=disable"
    finally:
        subprocess.run([f"{bindir}/pg_ctl", "-D", str(data), "-m", "immediate", "stop"], capture_output=True)


def test_provision_against_a_real_server(admin_url):
    import psycopg
    slug = f"studio-test-{int(time.time() * 1000) % 10**8}"
    name = database_name(slug)
    try:
        url = provision_database(admin_url, slug)
        assert url == database_url(admin_url, name)
        assert provision_database(admin_url, slug) == url                  # second call: already there
        with psycopg.connect(url, autocommit=True) as c:
            got = c.execute("select current_database()").fetchone()[0]
            assert (got.decode() if isinstance(got, bytes) else got) == name    # bytes on a SQL_ASCII server
            c.execute("create table t (id int)")                            # usable by the same credentials
    finally:
        with psycopg.connect(admin_url, autocommit=True) as c:
            c.execute(f'drop database if exists "{name}"')
