#!/usr/bin/env python3
"""爬取新华保险万能险和投连险产品页面"""

import os
import json
import time
import subprocess
from datetime import datetime

BASE_DIR = "/Users/wenshuping/Documents/OCR_insurance/crawled/新华保险"

# 万能险产品 (30个) - 统一使用 node/630 页面
wanneng_products = [
    ("得意理财两全保险(万能型)", "00902000"),
    ("至爱无双终身寿险(万能型)", "00909000"),
    ("得意理财两全保险(万能型,II)", "00903000"),
    ("金包银一号两全保险(万能型)", "00905000"),
    ("得意理财两全保险(万能型,III)", "00904000"),
    ("至尊双利终身寿险(万能型)", "00907000"),
    ("鑫金利终身寿险（万能型）", "00934000"),
    ("鑫天利养老年金保险（万能险）", "00933000"),
    ("鑫金利卓越版终身寿险(万能型)", "00X01000"),
    ("鑫天利卓越版养老年金保险(万能型)", "00X02000"),
    ("金利终身寿险（万能型）", "00926000"),
    ("金利优享终身寿险（万能型）", "00927000"),
    ("金利瑞享终身寿险（万能型）", "00930000"),
    ("金利满盈终身寿险（万能险）", "00931000"),
    ("金利稳盈终身寿险(万能型)", "00932000"),
    ("金彩随享两全保险(万能型)", "00910100"),
    ("精选一号两全保险(万能型)", "00912100"),
    ("附加精选二号两全保险(万能型)", "00913000"),
    ("i理财两全保险(万能型)", "00914000"),
    ("团体年金保险(万能型)", "00906000"),
    ("附加随意领年金保险（万能型）", "00915000"),
    ("i财两全保险（万能型）", "00916000"),
    ("利多派两全保险（万能型)", "00917000"),
    ("附加随意领白金版年金保险（万能型）", "00918000"),
    ("i理财二号两全保险(万能型)", "00919000"),
    ("利多派二号两全保险（万能型）", "00921000"),
    ("团体养老年金保险（万能型）", "00922000"),
    ("个人税收优惠型健康保险（万能型）A款", "00545000"),
    ("个人税收优惠型健康保险（万能型）B款", "00546000"),
    ("天利年金保险（万能型）", "00924000"),
]

# 投连险产品 (3个) - 使用 node/610 页面
toulian_products = [
    ("i添财年金保险（投资连结型）", "00892000"),
    ("新华创世之约投资连结保险", "00890000"),
    ("创世之约投资连结型个人终身寿险", "00888000"),
]

def sanitize_filename(name):
    """清理文件名，去除非法字符"""
    return name.replace('/', '-').replace('\\', '-').replace(':', '：').replace('*', '').replace('?', '').replace('"', '').replace('<', '').replace('>', '').replace('|', '')

def crawl_product(name, code, product_type):
    """爬取单个产品页面"""
    # 确定URL
    if product_type == "万能险":
        url = f"https://www.newchinalife.com/node/630?riskCode={code}"
    else:  # 投连险
        url = f"https://www.newchinalife.com/node/610?riskCode={code}"
    
    # 创建目录
    safe_name = sanitize_filename(name)
    product_dir = os.path.join(BASE_DIR, safe_name)
    os.makedirs(product_dir, exist_ok=True)
    
    # 使用curl下载
    output_file = os.path.join(product_dir, "产品详情.md")
    
    # 检查是否已存在
    if os.path.exists(output_file):
        print(f"  [跳过] {name} (已存在)")
        return True
    
    cmd = [
        "curl", "-s", "-L", "-A",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "-H", "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "-H", "Accept-Language: zh-CN,zh;q=0.9,en;q=0.8",
        url,
        "--output", output_file,
        "--max-time", "30"
    ]
    
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=35)
        if os.path.exists(output_file) and os.path.getsize(output_file) > 100:
            size = os.path.getsize(output_file)
            print(f"  [成功] {name} ({size} bytes)")
            return True
        else:
            print(f"  [失败] {name} - 文件不存在或太小")
            return False
    except Exception as e:
        print(f"  [错误] {name} - {str(e)}")
        return False

def main():
    print(f"开始爬取新华保险万能险和投连险产品...")
    print(f"输出目录: {BASE_DIR}")
    print("=" * 60)
    
    # 先爬万能险
    print(f"\n万能险产品 ({len(wanneng_products)}个):")
    wanneng_success = 0
    for i, (name, code) in enumerate(wanneng_products):
        print(f"  [{i+1}/{len(wanneng_products)}]", end=" ")
        if crawl_product(name, code, "万能险"):
            wanneng_success += 1
        time.sleep(0.5)  # 避免请求过快
    
    print(f"\n投连险产品 ({len(toulian_products)}个):")
    toulian_success = 0
    for i, (name, code) in enumerate(toulian_products):
        print(f"  [{i+1}/{len(toulian_products)}]", end=" ")
        if crawl_product(name, code, "投连险"):
            toulian_success += 1
        time.sleep(0.5)
    
    print("\n" + "=" * 60)
    print(f"万能险: 成功 {wanneng_success}/{len(wanneng_products)}")
    print(f"投连险: 成功 {toulian_success}/{len(toulian_products)}")
    print(f"总计: 成功 {wanneng_success + toulian_success}/{len(wanneng_products) + len(toulian_products)}")

if __name__ == "__main__":
    main()
