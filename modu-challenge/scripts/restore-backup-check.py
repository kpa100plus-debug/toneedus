"""Read-only isolated restore verification; never connects to production."""
import json, sqlite3, sys
from pathlib import Path
conn=sqlite3.connect(':memory:')
try:
    conn.executescript(Path(sys.argv[1]).read_text())
    integrity=[row[0] for row in conn.execute('PRAGMA integrity_check')]
    foreign=list(conn.execute('PRAGMA foreign_key_check'))
    if integrity!=['ok'] or foreign:
        raise ValueError('Invalid integrity or foreign keys')
    tables=[row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
    if not {'users','challenges','admin_roles'}.issubset(tables):
        raise ValueError('Required production tables missing')
    # Preserve counts for all tables, including sessions/OTPs omitted from the
    # durable inventory. Never write schema, records or SQLite error text to logs.
    counts={table:conn.execute('SELECT count(*) FROM "'+table.replace('"','""')+'"').fetchone()[0] for table in tables}
    result={'restoreVerified':True,'integrity':integrity,'foreignKeyViolations':len(foreign),'tableCount':len(tables),'counts':counts}
    Path(sys.argv[2]).write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result))
except (sqlite3.Error, ValueError):
    raise SystemExit('Isolated backup restore validation failed; deployment stopped') from None
finally:
    conn.close()
