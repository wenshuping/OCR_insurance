#!/usr/bin/env python3
"""
新华保险产品披露材料爬虫
从 https://www.newchinalife.com/info/4596 爬取790个产品的披露材料
"""

import urllib.request
import urllib.parse
import json
import time
import re
import os
from datetime import datetime

BASE_URL = 'https://www.newchinalife.com/info/4596'
OUTPUT_DIR = '/Users/wenshuping/Documents/OCR_insurance/crawled/新华保险'

def load_products():
    """加载之前爬取的产品列表"""
    products_file = OUTPUT_DIR + '/disclosure_products.json'
    with open(products_file, 'r', encoding='utf-8') as f:
        return json.load(f)

def fetch_page(product_name, page=1):
    """获取某个产品的披露材料页面"""
    params = urllib.parse.urlencode({
        'productName': product_name,
        'page': page
    })
    url = f'{BASE_URL}?{params}'

    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Referer': 'https://www.newchinalife.com/',
    })

    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return response.read().decode('utf-8')
    except Exception as e:
        print(f'Error fetching {product_name}: {e}')
        return None

def extract_materials(html, product_name):
    """从HTML中提取披露材料链接"""
    materials = []

    # 查找PDF链接
    pdf_pattern = re.compile(r'href=["\']([^"\']+\.pdf[^"\']*)["\'][^>]*>([^<]*)', re.DOTALL)
    for match in pdf_pattern.findall(html):
        url = match[0]
        title = re.sub(r'<[^>]+>', '', match[1]).strip()
        if 'pdf' in url.lower():
            materials.append({
                'url': url if url.startswith('http') else f'https://www.newchinalife.com{url}',
                'title': title or 'PDF文档',
                'type': 'pdf'
            })

    # 查找条款、产品说明书等链接
    keyword_pattern = re.compile(r'href=["\']([^"\']+)["\'][^>]*>([^<]*(?:条款|说明书|费率表|现金价值|利益条款|保险责任)[^<]*)', re.DOTALL)
    for match in keyword_pattern.findall(html):
        url = match[0]
        title = re.sub(r'<[^>]+>', '', match[1]).strip()
        if url and title:
            materials.append({
                'url': url if url.startswith('http') else f'https://www.newchinalife.com{url}',
                'title': title,
                'type': 'html'
            })

    return materials

def sanitize_filename(name):
    """清理文件名"""
    return re.sub(r'[<>:"/\\|?*]', '', name)[:100]

def download_file(url, product_dir, title):
    """下载文件"""
    try:
        req = urllib.request.Request(url, headers={
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            'Accept': 'application/pdf,*/*',
        })

        with urllib.request.urlopen(req, timeout=60) as response:
            content = response.read()
            content_type = response.headers.get('Content-Type', '')

            # 确定文件扩展名
            if 'pdf' in content_type.lower() or '.pdf' in url.lower():
                ext = '.pdf'
            elif 'doc' in content_type.lower():
                ext = '.doc'
            elif 'docx' in content_type.lower():
                ext = '.docx'
            else:
                ext = '.pdf' if '.pdf' in url.lower() else '.html'

            filename = sanitize_filename(title) + ext
            filepath = os.path.join(product_dir, filename)

            with open(filepath, 'wb') as f:
                f.write(content)

            return filepath
    except Exception as e:
        print(f'  Download error: {e}')
        return None

def crawl_product(product):
    """爬取单个产品的披露材料"""
    product_name = product['name']
    category = product['category']
    status = product['status']

    print(f'\n爬取: {product_name}')
    print(f'  分类: {category} | 状态: {status}')

    # 创建产品目录
    safe_name = sanitize_filename(product_name)
    product_dir = os.path.join(OUTPUT_DIR, safe_name)
    os.makedirs(product_dir, exist_ok=True)

    # 获取披露页面
    html = fetch_page(product_name)
    if not html:
        return None

    # 提取材料
    materials = extract_materials(html, product_name)

    if not materials:
        print(f'  未找到披露材料')
        # 保存HTML供后续分析
        html_path = os.path.join(product_dir, 'disclosure_page.html')
        with open(html_path, 'w', encoding='utf-8') as f:
            f.write(html)
        return []

    print(f'  找到 {len(materials)} 个披露材料:')
    downloaded = []
    for mat in materials:
        print(f'    - {mat["title"]}: {mat["url"][:80]}...')

        if mat['type'] == 'pdf':
            filepath = download_file(mat['url'], product_dir, mat['title'])
            if filepath:
                downloaded.append(filepath)
                print(f'      已下载: {os.path.basename(filepath)}')

    # 保存产品信息
    info = {
        'name': product_name,
        'category': category,
        'status': status,
        'materials': materials,
        'downloaded': [os.path.basename(f) for f in downloaded],
        'crawl_time': datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    }

    with open(os.path.join(product_dir, 'product_info.json'), 'w', encoding='utf-8') as f:
        json.dump(info, f, ensure_ascii=False, indent=2)

    return downloaded

def main():
    print('=' * 60)
    print('新华保险产品披露材料爬虫')
    print('=' * 60)

    # 加载产品列表
    products = load_products()
    print(f'已加载 {len(products)} 个产品')

    # 显示前5个产品
    print('\n前5个产品:')
    for p in products[:5]:
        print(f'  - {p["name"]} ({p["category"]}) - {p["status"]}')

    # 统计
    categories = {}
    for p in products:
        cat = p['category']
        categories[cat] = categories.get(cat, 0) + 1

    print('\n产品分类统计:')
    for cat, count in sorted(categories.items(), key=lambda x: -x[1]):
        print(f'  {cat}: {count}个')

    # 爬取所有790个产品
    print('\n' + '=' * 60)
    print(f'开始爬取全部 {len(products)} 个产品...')
    print('=' * 60)

    downloaded_count = 0
    error_count = 0

    for i, product in enumerate(products):
        print(f'\n[{i+1}/{len(products)}] ', end='')
        result = crawl_product(product)
        if result:
            downloaded_count += len(result)
        else:
            error_count += 1

        # 每50个产品显示进度
        if (i + 1) % 50 == 0:
            print(f'\n--- 进度: {i+1}/{len(products)} | 已下载: {downloaded_count} | 错误: {error_count} ---')

        time.sleep(0.5)  # 礼貌性延迟

    print('\n' + '=' * 60)
    print('全部爬取完成!')
    print('=' * 60)
    print(f'爬取产品数: {len(products)}')
    print(f'下载文件数: {downloaded_count}')
    print(f'错误数: {error_count}')

if __name__ == '__main__':
    main()