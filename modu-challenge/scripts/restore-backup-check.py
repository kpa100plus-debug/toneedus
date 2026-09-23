"""Read-only isolated restore verification; never connects to production."""
import json, sqlite3, sys
from pathlib import Path
conn=sqlite3.connect(':memory:')
conn.executescript(Path(sys.argv[1]).read_text())
integrity=[row[0] for row in conn.execute('PRAGMA integrity_check')]
foreign=list(conn.execute('PRAGMA foreign_key_check'))
if integrity!=['ok'] or foreign: raise SystemExit('Isolated backup restore validation failed')
result={'integrity':integrity,'foreignKeyViolations':len(foreign),'counts':{t:conn.execute('SELECT count(*) FROM '+t).fetchone()[0] for t in ['users','challenges','admin_roles']}}
Path(sys.argv[2]).write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
conn.close()
