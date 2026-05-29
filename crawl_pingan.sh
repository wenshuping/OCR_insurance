#!/bin/bash
# 爬取中国平安产品列表和文档
OUTPUT_DIR="/Users/wenshuping/Documents/OCR_insurance/crawled/中国平安"
mkdir -p "$OUTPUT_DIR"

echo "=== 中国平安产品爬虫 ==="
echo "开始时间: $(date '+%Y-%m-%d %H:%M:%S')"

# Step 1: 获取所有在售产品
echo ""
echo "[1/3] 获取产品列表..."

# 先获取总数
TOTAL=$(curl -s -k -X POST 'https://life.pingan.com/ilife-home/product/getProductList' \
  -H 'Content-Type: application/json' \
  -H 'Referer: https://life.pingan.com/p/' \
  -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' \
  -d '{"pageNum":1,"pageSize":50,"planSalesStatus":"Y","isOrNotSale":"Y","isOnlyNew":"N"}' \
  --max-time 20 | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('DATA',[])))" 2>/dev/null || echo "0")

echo "第一页获取: $TOTAL 个产品"

# 获取所有产品
ALL_PRODUCTS='[]'
PAGE=1
while true; do
  RESP=$(curl -s -k -X POST 'https://life.pingan.com/ilife-home/product/getProductList' \
    -H 'Content-Type: application/json' \
    -H 'Referer: https://life.pingan.com/p/' \
    -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' \
    -d "{\"pageNum\":$PAGE,\"pageSize\":50,\"planSalesStatus\":\"Y\",\"isOrNotSale\":\"Y\",\"isOnlyNew\":\"N\"}" \
    --max-time 20)
  
  DATA=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d.get('DATA',[])))" 2>/dev/null)
  
  if [ "$DATA" = "[]" ] || [ -z "$DATA" ]; then
    break
  fi
  
  ALL_PRODUCTS=$(echo "$ALL_PRODUCTS" | python3 -c "import sys,json; a=json.load(sys.stdin); d=json.loads('''$DATA'''); a.extend(d); print(json.dumps(a))" 2>/dev/null)
  echo "第${PAGE}页完成, 累计: $(echo "$ALL_PRODUCTS" | python3 -c 'import sys,json; print(len(json.load(sys.stdin)))')"
  
  if [ "$DATA" = "[]" ]; then
    break
  fi
  
  PAGE=$((PAGE + 1))
  sleep 0.5
done

# 保存产品列表
echo "$ALL_PRODUCTS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'共获取 {len(d)} 个产品')"
echo "$ALL_PRODUCTS" > "$OUTPUT_DIR/products_list.json"
echo "已保存: $OUTPUT_DIR/products_list.json"

# Step 2: 下载PDF文档
echo ""
echo "[2/3] 下载产品文档..."

sanitize() {
  echo "$1" | sed 's/\//-/g' | sed 's/\\/-/g' | sed 's/：/:/g' | sed 's/\*/x/g' | sed 's/?/？/g'
}

# 遍历产品下载PDF
COUNT=0
TOTAL_COUNT=$(echo "$ALL_PRODUCTS" | python3 -c 'import sys,json; print(len(json.load(sys.stdin)))')
FAILED=0

echo "$ALL_PRODUCTS" | python3 -c '
import sys,json,os,subprocess,time
products = json.load(sys.stdin)
for i,p in enumerate(products):
    plan_code = p.get("planCode","")
    version_no = p.get("versionNo","")
    name = p.get("clauseName","")
    if not name: name = plan_code
    name = name.replace("/","-").replace("\\","-")
    product_dir = f"/Users/wenshuping/Documents/OCR_insurance/crawled/中国平安/{name}"
    os.makedirs(product_dir, exist_ok=True)
    
    # 保存product_info
    info_file = f"{product_dir}/product_info.json"
    if not os.path.exists(info_file):
        with open(info_file,"w") as f:
            json.dump(p, f, ensure_ascii=False)
    
    # 下载PDF
    for att_type, fname in [(1,"产品条款.pdf"),(2,"产品费率表.pdf"),(7,"产品说明书.pdf")]:
        pdf_path = f"{product_dir}/{fname}"
        if os.path.exists(pdf_path) and os.path.getsize(pdf_path) > 1000:
            continue
        url = f"https://life.pingan.com/ilife-home/product/getPlanClausePdf?planCode={plan_code}&versionNo={version_no}&attachmentType={att_type}"
        result = subprocess.run(["curl","-s","-k","-L","-o",pdf_path,
            "-H","Referer: https://life.pingan.com/p/",
            "-H","User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
            url,"--max-time","30"], capture_output=True)
        time.sleep(0.2)
    
    COUNT = i + 1
    if COUNT % 10 == 0:
        print(f"进度: {COUNT}/{len(products)}")
' 2>&1

echo "文档下载完成"

# Step 3: 生成list.json
echo ""
echo "[3/3] 生成产品列表..."

echo "$ALL_PRODUCTS" | python3 -c '
import sys,json,os
from datetime import datetime
products = json.load(sys.stdin)
OUTPUT_DIR = "/Users/wenshuping/Documents/OCR_insurance/crawled/中国平安"

result = {
    "保险公司": "中国平安人寿保险股份有限公司",
    "简称": "中国平安",
    "爬取时间": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    "总产品数": len(products),
    "产品列表": []
}

for p in products:
    name = p.get("clauseName","")
    if not name: name = p.get("planCode","")
    name = name.replace("/","-")
    product_dir = f"{OUTPUT_DIR}/{name}"
    
    files = []
    if os.path.exists(product_dir):
        for f in os.listdir(product_dir):
            if f.endswith(".pdf"):
                size = os.path.getsize(f"{product_dir}/{f}")
                files.append({"文件名": f, "大小": size})
    
    result["产品列表"].append({
        "产品代码": p.get("planCode",""),
        "产品名称": name,
        "版本号": p.get("versionNo",""),
        "销售状态": p.get("planSalesStatus",""),
        "产品类型": p.get("planPlanType",""),
        "销售渠道": p.get("planSalesChannel",""),
        "发布时间": p.get("startDate",""),
        "产品分级": p.get("productLevel",""),
        "文件列表": files
    })

with open(f"{OUTPUT_DIR}/list.json","w",encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False, indent=2)
print(f"已生成: {OUTPUT_DIR}/list.json")
'

echo ""
echo "=== 完成 ==="
echo "结束时间: $(date '+%Y-%m-%d %H:%M:%S')"
