#!/usr/bin/env python3
"""
保险公司产品爬虫 - 按MD文件顺序爬取前10家
策略: PDF/Word下载 > 否则截图
"""

import os
import re
import json
import time
import urllib.request
import urllib.error
from urllib.parse import urljoin

# 配置
OUTPUT_BASE = "/Users/wenshuping/Documents/OCR_insurance/crawled"
os.makedirs(OUTPUT_BASE, exist_ok=True)

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
}

# 10家保险公司配置 (跳过中国人寿，已爬取)
COMPANIES = [
    {
        "name": "新华",
        "domain": "https://www.newchinalife.com",
        "product_paths": ["/product/", "/cpzx/", "/chanpin/"],
        "name_patterns": ["个人保险", "团体保险", "银行代理", "互联网保险"]
    },
    {
        "name": "中国平安",
        "domain": "https://www.pingan.com",
        "product_paths": ["/insurance/", "/life/"],
        "name_patterns": []
    },
    {
        "name": "太保寿险",
        "domain": "https://life.cpic.com.cn",
        "product_paths": ["/xrsbx/", "/cpzx/"],
        "name_patterns": ["人寿保险", "健康保险", "意外保险", "重疾保险"]
    },
    {
        "name": "中国太保",
        "domain": "https://www.cpic.com.cn",
        "product_paths": ["/insurance/", "/life/"],
        "name_patterns": []
    },
    {
        "name": "泰康",
        "domain": "https://www.taikang.com",
        "product_paths": ["/product/", "/insurance/"],
        "name_patterns": []
    },
    {
        "name": "中国太平",
        "domain": "https://www.cntaiping.com",
        "product_paths": ["/product/", "/insurance/"],
        "name_patterns": []
    },
    {
        "name": "中国人民保险",
        "domain": "https://www.picclife.com",
        "product_paths": ["/product/", "/insurance/"],
        "name_patterns": []
    },
    {
        "name": "阳光寿险",
        "domain": "https://www.sinosig.com",
        "product_paths": ["/product/", "/life/"],
        "name_patterns": []
    },
    {
        "name": "友邦寿险",
        "domain": "https://www.aia.com.cn",
        "product_paths": ["/product/", "/insurance/"],
        "name_patterns": []
    },
]

def make_request(url, timeout=15):
    """发送HTTP请求"""
    try:
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return response.read().decode('utf-8', errors='ignore')
    except Exception as e:
        print(f"  请求失败: {url} - {e}")
        return None

def find_product_links(html, base_url):
    """从页面HTML中提取产品链接"""
    links = []
    
    # 查找所有链接
    pattern = r'href=["\']([^"\']+)["\']'
    all_links = re.findall(pattern, html)
    
    for link in all_links:
        full_url = urljoin(base_url, link)
        # 过滤可能是产品页面的链接
        if any(keyword in link.lower() for keyword in ['product', 'cpzx', 'chanpin', 'insurance', 'detail', 'info', 'xq']):
            if full_url not in links and full_url.startswith('http'):
                links.append(full_url)
    
    return links[:10]  # 限制数量

def find_images(html, base_url):
    """从HTML中提取图片URL"""
    images = []
    pattern = r'src=["\']([^"\']+\.(jpg|jpeg|png|gif))["\']'
    matches = re.findall(pattern, html, re.I)
    
    for img_url, ext in matches:
        full_url = urljoin(base_url, img_url)
        # 过滤掉logo、icon等无关图片
        if any(keyword in img_url.lower() for keyword in ['product', 'upload', 'resources', 'image', 'img']):
            if full_url not in images:
                images.append(full_url)
    
    return images

def crawl_company(company):
    """爬取单个保险公司的产品"""
    name = company['name']
    domain = company['domain']
    
    print(f"\n{'='*50}")
    print(f"🔍 爬取: {name} ({domain})")
    print(f"{'='*50}")
    
    # 创建目录
    company_dir = os.path.join(OUTPUT_BASE, name)
    os.makedirs(company_dir, exist_ok=True)
    
    results = {
        'company': name,
        'domain': domain,
        'products': [],
        'errors': []
    }
    
    # 尝试访问产品页面
    product_urls = []
    for path in company.get('product_paths', []):
        url = domain if path == '/' else domain + path
        print(f"\n  尝试: {url}")
        
        html = make_request(url)
        if html:
            print(f"  ✅ 访问成功")
            
            # 查找产品链接
            links = find_product_links(html, url)
            product_urls.extend(links)
            
            # 查找图片
            images = find_images(html, url)
            if images:
                print(f"  📷 找到 {len(images)} 张图片")
        
        time.sleep(0.5)
    
    # 去重
    product_urls = list(dict.fromkeys(product_urls))
    print(f"\n  找到 {len(product_urls)} 个产品页面")
    
    # 爬取每个产品页面
    for i, product_url in enumerate(product_urls[:5], 1):  # 限制每个公司最多5个产品
        print(f"\n  [{i}/{min(5, len(product_urls))}] 爬取产品: {product_url}")
        
        product_html = make_request(product_url)
        if not product_html:
            continue
        
        # 提取产品名称 (从title或h1)
        product_name = re.search(r'<title>([^<]+)</title>', product_html)
        product_name = product_name.group(1).split('-')[0].strip() if product_name else f"产品_{i}"
        
        # 清理名称
        product_name = re.sub(r'[^\u4e00-\u9fa5a-zA-Z0-9]', '_', product_name)
        product_name = product_name[:50]  # 限制长度
        
        print(f"    产品名: {product_name}")
        
        # 创建产品目录
        product_dir = os.path.join(company_dir, product_name)
        os.makedirs(product_dir, exist_ok=True)
        
        # 查找PDF/Word下载链接
        doc_links = re.findall(r'href=["\']([^"\']+\.(pdf|doc|docx))["\']', product_html, re.I)
        
        if doc_links:
            print(f"    📄 找到 {len(doc_links)} 个文档下载")
            # 下载文档
            for doc_url, ext in doc_links[:3]:  # 最多3个
                full_url = urljoin(product_url, doc_url)
                filename = f"产品文档.{ext.lower()}"
                filepath = os.path.join(product_dir, filename)
                try:
                    urllib.request.urlretrieve(full_url, filepath)
                    print(f"    ✅ 下载: {filename}")
                except Exception as e:
                    print(f"    ❌ 下载失败: {e}")
        else:
            print(f"    📷 无文档，截图...")
            
            # 查找产品图片
            images = find_images(product_html, product_url)
            if images:
                for j, img_url in enumerate(images[:4], 1):
                    filename = f"截图_{j}.jpg"
                    filepath = os.path.join(product_dir, filename)
                    try:
                        urllib.request.urlretrieve(img_url, filepath)
                        print(f"    ✅ 下载: {filename}")
                    except Exception as e:
                        print(f"    ❌ 下载失败: {e}")
            else:
                print(f"    ⚠️ 未找到图片")
        
        # 保存HTML用于后续分析
        html_file = os.path.join(product_dir, "page.html")
        with open(html_file, 'w', encoding='utf-8') as f:
            f.write(product_html)
        
        results['products'].append({
            'name': product_name,
            'url': product_url,
            'has_doc': bool(doc_links),
            'image_count': len(images) if not doc_links else 0
        })
        
        time.sleep(0.3)
    
    return results

def main():
    """主函数"""
    print("="*60)
    print("🚗 保险公司产品爬虫启动")
    print(f"📁 输出目录: {OUTPUT_BASE}")
    print("="*60)
    
    all_results = []
    
    for company in COMPANIES:
        result = crawl_company(company)
        all_results.append(result)
        time.sleep(1)  # 避免请求过快
    
    # 保存汇总结果
    summary_file = os.path.join(OUTPUT_BASE, "crawl_summary.json")
    with open(summary_file, 'w', encoding='utf-8') as f:
        json.dump(all_results, f, ensure_ascii=False, indent=2)
    
    print("\n" + "="*60)
    print("✅ 爬取完成!")
    print(f"📊 结果已保存: {summary_file}")
    print("="*60)

if __name__ == "__main__":
    main()
