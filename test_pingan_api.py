#!/usr/bin/env python3
"""测试中国平安API"""
import requests
import json

url = 'https://life.pingan.com/ilife-home/product/getProductList'
headers = {
    'Content-Type': 'application/json',
    'Referer': 'https://life.pingan.com/p/',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
}

data = {"pageNum":1,"pageSize":5,"planSalesStatus":"Y","isOrNotSale":"Y","isOnlyNew":"N"}

try:
    resp = requests.post(url, headers=headers, json=data, timeout=10, verify=False)
    print("状态码:", resp.status_code)
    print("响应:", resp.text[:500])
except Exception as e:
    print("错误:", e)
