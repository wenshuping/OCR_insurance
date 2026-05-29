#!/usr/bin/env python3
"""爬取中国平安人寿保险产品文档"""
import os
import json
import time
import requests
import urllib3
from datetime import datetime

# 禁用SSL警告
import warnings
warnings.filterwarnings("ignore", message="Unverified HTTPS request")

# 配置
OUTPUT_DIR = "/Users/wenshuping/Documents/OCR_insurance/crawled/中国平安"
API_URL = "https://life.pingan.com/ilife-home/product/getProductList"
PDF_URL = "https://life.pingan.com/ilife-home/product/getPlanClausePdf"

HEADERS = {
    'Content-Type': 'application/json',
    'Referer': 'https://life.pingan.com/p/',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
}

def get_products():
    """获取所有在售产品列表"""
    all_products = []
    page = 1
    page_size = 50
    
    while True:
        data = {
            "pageNum": page,
            "pageSize": page_size,
            "planSalesStatus": "Y",
            "isOrNotSale": "Y",
            "isOnlyNew": "N"
        }
        
        try:
            resp = requests.post(API_URL, headers=HEADERS, json=data, timeout=15, verify=False)
            resp.raise_for_status()
            result = resp.json()
            
            if result.get('CODE') != '00':
                print(f"API错误: {result}")
                break
            
            products = result.get('DATA', [])
            if not products:
                break
                
            all_products.extend(products)
            print(f"第{page}页: 获取{len(products)}个产品, 累计{len(all_products)}个")
            
            if len(products) < page_size:
                break
                
            page += 1
            time.sleep(0.5)
            
        except Exception as e:
            print(f"获取产品列表失败 (第{page}页): {e}")
            break
    
    return all_products

def sanitize_filename(name):
    """清理文件名"""
    return name.replace('/', '-').replace('\\', '-').replace(':', '：').replace('*', '×').replace('?', '？').replace('"', '"').replace('<', '《').replace('>', '》').replace('|', '｜')

def download_pdf(url, filepath, referer='https://life.pingan.com/p/'):
    """下载PDF文件"""
    try:
        # 检查是否已存在
        if os.path.exists(filepath):
            size = os.path.getsize(filepath)
            if size > 1000:
                return True
        
        headers = {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': referer,
        }
        
        resp = requests.get(url, headers=headers, timeout=30, verify=False, allow_redirects=True)
        
        if resp.status_code == 200 and len(resp.content) > 1000:
            # 检查是否是PDF
            if resp.content[:4] == b'%PDF':
                with open(filepath, 'wb') as f:
                    f.write(resp.content)
                return True
            else:
                print(f"  响应不是PDF: {len(resp.content)} bytes")
        return False
    except Exception as e:
        print(f"  下载失败: {e}")
        return False

def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    print(f"输出目录: {OUTPUT_DIR}")
    print("=" * 60)
    print(f"开始时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 60)
    
    # Step 1: 获取产品列表
    print("\n[1/3] 获取产品列表...")
    products = get_products()
    print(f"共获取 {len(products)} 个产品")
    
    if not products:
        print("获取产品列表失败!")
        return
    
    # 保存产品列表
    products_file = os.path.join(OUTPUT_DIR, 'products_list.json')
    with open(products_file, 'w', encoding='utf-8') as f:
        json.dump(products, f, ensure_ascii=False, indent=2)
    print(f"产品列表已保存: {products_file}")
    
    # Step 2: 下载文档
    print("\n[2/3] 下载产品文档...")
    
    # 文档类型: 1=条款, 2=费率表, 7=说明书
    doc_types = [
        (1, "产品条款.pdf"),
        (2, "产品费率表.pdf"),
        (7, "产品说明书.pdf"),
    ]
    
    success_count = 0
    fail_count = 0
    
    for i, product in enumerate(products):
        plan_code = product.get('planCode', '')
        version_no = product.get('versionNo', '')
        name = sanitize_filename(product.get('clauseName', product.get('planName', plan_code)))
        
        product_dir = os.path.join(OUTPUT_DIR, name)
        os.makedirs(product_dir, exist_ok=True)
        
        # 保存产品信息
        info_file = os.path.join(product_dir, 'product_info.json')
        if not os.path.exists(info_file):
            with open(info_file, 'w', encoding='utf-8') as f:
                json.dump(product, f, ensure_ascii=False, indent=2)
        
        # 下载PDF
        downloaded = 0
        for att_type, filename in doc_types:
            url = f"{PDF_URL}?planCode={plan_code}&versionNo={version_no}&attachmentType={att_type}"
            filepath = os.path.join(product_dir, filename)
            
            if download_pdf(url, filepath):
                downloaded += 1
        
        if downloaded > 0:
            success_count += 1
            print(f"[{i+1}/{len(products)}] {name}: {downloaded}个文档")
        else:
            fail_count += 1
            print(f"[{i+1}/{len(products)}] {name}: 下载失败")
        
        time.sleep(0.3)
    
    print(f"\n下载完成: 成功{success_count}个, 失败{fail_count}个")
    
    # Step 3: 生成list.json
    print("\n[3/3] 生成产品列表...")
    list_data = {
        "保险公司": "中国平安人寿保险股份有限公司",
        "简称": "中国平安",
        "爬取时间": datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        "总产品数": len(products),
        "成功下载": success_count,
        "下载失败": fail_count,
        "产品列表": []
    }
    
    for product in products:
        name = sanitize_filename(product.get('clauseName', product.get('planName', '')))
        product_dir = os.path.join(OUTPUT_DIR, name)
        files = []
        if os.path.exists(product_dir):
            for f in os.listdir(product_dir):
                if f.endswith('.pdf'):
                    size = os.path.getsize(os.path.join(product_dir, f))
                    files.append({"文件名": f, "大小": size})
        
        list_data["产品列表"].append({
            "产品代码": product.get('planCode', ''),
            "产品名称": name,
            "版本号": product.get('versionNo', ''),
            "销售状态": product.get('planSalesStatus', ''),
            "产品类型": product.get('planPlanType', ''),
            "销售渠道": product.get('planSalesChannel', ''),
            "发布时间": product.get('startDate', ''),
            "产品分级": product.get('productLevel', ''),
            "备案文号": product.get('reportPreparedFileCode', ''),
            "文件列表": files
        })
    
    list_file = os.path.join(OUTPUT_DIR, 'list.json')
    with open(list_file, 'w', encoding='utf-8') as f:
        json.dump(list_data, f, ensure_ascii=False, indent=2)
    
    print(f"完成! 列表已保存: {list_file}")
    print(f"结束时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")

if __name__ == "__main__":
    main()
