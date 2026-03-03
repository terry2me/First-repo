import requests
import json

BASE_URL = "http://127.0.0.1:8000"

def test_search(code):
    print(f"Testing search for {code}...")
    try:
        resp = requests.post(f"{BASE_URL}/api/stock", json={
            "code": code,
            "candle_count": 52,
            "interval": "1d"
        })
        print(f"Status: {resp.status_code}")
        if resp.ok:
            data = resp.json()
            print(f"Name: {data['name']}, Last Price: {data['currentPrice']}")
        else:
            print(f"Error: {resp.text}")
    except Exception as e:
        print(f"Exception: {e}")

test_search("005380")
test_search("TSLA")

# Since I can't be sure the server is running, I'll try to run the server in the background first.
