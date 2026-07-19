import requests
import json

# Configuration
API_KEY = "fg-ab7891def55c4f83b833b6e28512b40d"
BASE_URL = "https://forge-gateway-api.fly.dev/v1"
MODEL = "glm-5.2"

def test_openai_endpoint():
    print(f"\n--- 1. Testing OpenAI Chat Completions Format ---")
    url = f"{BASE_URL}/chat/completions"
    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json"
    }
    payload = {
        "model": MODEL,
        "messages": [{"role": "user", "content": "Hi"}],
        "max_tokens": 10
    }
    
    print(f"POST to: {url}")
    try:
        response = requests.post(url, headers=headers, json=payload, timeout=10)
        print(f"HTTP Status: {response.status_code}")
        if response.status_code == 200:
            print("[✅] Success!")
            print(f"Response: {response.json()['choices'][0]['message']['content']}")
        else:
            print(f"[❌] Failed with Status {response.status_code}")
            print(f"Raw Response: {response.text}")
    except Exception as e:
        print(f"[❌] Connection Error: {e}")

def test_anthropic_endpoint():
    print(f"\n--- 2. Testing Anthropic Messages Format (What Claude Code uses) ---")
    url = f"{BASE_URL}/messages"
    # Claude Code sends an x-api-key header instead of Authorization Bearer
    headers = {
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json"
    }
    payload = {
        "model": MODEL,
        "messages": [{"role": "user", "content": "Hi"}],
        "max_tokens": 10
    }
    
    print(f"POST to: {url}")
    try:
        response = requests.post(url, headers=headers, json=payload, timeout=10)
        print(f"HTTP Status: {response.status_code}")
        if response.status_code == 200:
            print("[✅] Success!")
            print(f"Response: {response.json()['content'][0]['text']}")
        else:
            print(f"[❌] Failed with Status {response.status_code}")
            print(f"Raw Response: {response.text}")
    except Exception as e:
        print(f"[❌] Connection Error: {e}")

if __name__ == "__main__":
    test_openai_endpoint()
    test_anthropic_endpoint()
