"""Run the SAGE console:  python -m server [--host 127.0.0.1] [--port 8000] [--reload]"""
import argparse
import os
import sys

import uvicorn

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)


def main():
    ap = argparse.ArgumentParser(description='SAGE console')
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--port', type=int, default=8000)
    ap.add_argument('--reload', action='store_true', help='restart on source changes (development)')
    args = ap.parse_args()
    print('SAGE console  ->  http://%s:%d' % (args.host, args.port), flush=True)
    uvicorn.run('server.app:app', host=args.host, port=args.port, reload=args.reload, log_level='info')


if __name__ == '__main__':
    main()
