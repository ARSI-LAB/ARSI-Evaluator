
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
safe_record('four rows including credit', lambda: len(rows)==4)
safe_record('header order stable', lambda: list(rows[0].keys())==['invoice_id','customer','issued_at','description','quantity','unit_cents','subtotal_cents','tax_cents','credit_cents','line_total_cents','currency'])
seats=next((r for r in rows if r['invoice_id']=='inv1' and r['description']=='Seats'), {})
storage=next((r for r in rows if r.get('description')=='Extra storage'), {})
credit=next((r for r in rows if r.get('description')=='Credit'), {})
safe_record('quoted customer with comma round trips', lambda: seats['customer']=='Acme, Inc.')
safe_record('seat subtotal and tax correct', lambda: seats['subtotal_cents']=='3000' and seats['tax_cents']=='300')
safe_record('storage subtotal and rounded tax correct', lambda: storage['subtotal_cents']=='500' and storage['tax_cents']=='50')
safe_record('credit row is negative line total', lambda: credit['line_total_cents']=='-300' and credit['credit_cents']=='300')
safe_record('zero tax invoice stays zero', lambda: next(r for r in rows if r['invoice_id']=='inv2')['tax_cents']=='0')
safe_record('rows sorted by invoice', lambda: [r['invoice_id'] for r in rows]==['inv1','inv1','inv1','inv2'])
safe_record('credit appears after normal inv1 lines', lambda: rows[2]['description']=='Credit')
safe_record('currency preserved', lambda: all(r['currency']=='USD' for r in rows))
safe_record('csv parse handles commas', lambda: len(rows[0])==11)
write_reward()
