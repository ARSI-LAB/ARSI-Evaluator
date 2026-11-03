
import csv
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT=Path(os.environ.get('WORKSPACE','/workspace'))
LOG_DIR=Path(os.environ.get('LOG_DIR','/logs/verifier'))
LOG_DIR.mkdir(parents=True, exist_ok=True)
sys.path.insert(0, str(ROOT))
RESULTS=[]

def record(name, passed, detail=''):
    RESULTS.append({'name': name, 'passed': bool(passed), 'detail': str(detail)})

def safe_record(name, check):
    try:
        record(name, check())
    except Exception as exc:
        record(name, False, f'{type(exc).__name__}: {exc}')

def run_cmd(args):
    return subprocess.run(args, cwd=ROOT, text=True, capture_output=True, timeout=20)

def write_reward():
    passed=sum(1 for item in RESULTS if item['passed'])
    total=len(RESULTS) or 1
    reward={'overall': passed/total, 'test_pass_rate': passed/total, 'tests_passed': passed, 'tests_total': total, 'test_status': 'pass' if passed==total else 'no_pass', 'tests': RESULTS}
    (LOG_DIR/'reward.json').write_text(json.dumps(reward, indent=2, ensure_ascii=False))
    (LOG_DIR/'reward.txt').write_text(str(reward['overall']))
    print(json.dumps(reward, indent=2, ensure_ascii=False))
proc=run_cmd(['python','app/export.py','--data','data','--out','export.csv'])
safe_record('command exits cleanly', lambda: proc.returncode==0)
rows=list(csv.DictReader((ROOT/'export.csv').open(newline='',encoding='utf-8')))
by={r['account_id']:r for r in rows}
safe_record('three accounts exported', lambda: len(rows)==3)
safe_record('columns stable', lambda: rows[0].keys()=={'account_id','name','owner','plan','active_users','projects','open_tickets','sev1','health','last_active'})
safe_record('red account sorted first', lambda: rows[0]['account_id']=='a3' and rows[0]['health']=='red')
safe_record('free inactive account yellow', lambda: by['a2']['health']=='yellow')
safe_record('healthy pro account green', lambda: by['a1']['health']=='green')
safe_record('numeric fields exported as strings', lambda: by['a3']['active_users']=='40' and by['a3']['open_tickets']=='5')
safe_record('owner field preserved', lambda: by['a1']['owner']=='Mia')
safe_record('plan field preserved', lambda: by['a3']['plan']=='enterprise')
safe_record('last active carried through', lambda: by['a2']['last_active']=='2026-06-01')
safe_record('sort order by health then owner/name', lambda: [r['account_id'] for r in rows]==['a3','a2','a1'])
safe_record('csv has header plus rows', lambda: len((ROOT/'export.csv').read_text().splitlines())==4)
safe_record('no blank account ids', lambda: all(r['account_id'] for r in rows))
write_reward()
