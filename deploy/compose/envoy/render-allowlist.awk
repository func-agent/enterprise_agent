# =============================================================================
# render-allowlist.awk —— 按 EGRESS_ALLOWED_HOSTS 重写 envoy.yaml 的三个白名单区块
#
# 用法：awk -v hosts="api.openai.com,dashscope.aliyuncs.com" -f render-allowlist.awk envoy.yaml
#
# 模板约定：区块内的域名使用 api.openai.com、集群名后缀使用 api_openai_com，
#           渲染时整体替换为实际白名单域名。
#
# 区块：
#   ALLOWED HTTP VHOSTS  —— 15000 监听器的白名单虚拟主机（取第一条作为模板克隆）
#   ALLOWED SNI CHAINS   —— 15001 监听器的白名单过滤链（取第一条作为模板克隆）
#   EGRESS CLUSTERS      —— 白名单域名对应的上游集群（整块作为模板克隆）
# =============================================================================

{ lines[NR] = $0 }

function find_marker(marker,   i) {
  for (i = 1; i <= NR; i++) {
    if (index(lines[i], marker) > 0) return i
  }
  return 0
}

# 取出模板块：mode=first 取区域内第一条以 indent 开头的条目；
#              mode=count 取区域内前 count 条条目（一个白名单域名对应 3 个集群）
function template_block(bs, be, indent, mode, count,   s, e, i, n) {
  if (mode == "whole") {
    return bs + 1
  }
  s = 0
  n = 0
  for (i = bs + 1; i < be; i++) {
    if (index(lines[i], indent) == 1) {
      n++
      if (s == 0) { s = i; continue }
      if (n >= count) return s
    }
  }
  return s
}

function template_end(ts, be, indent, mode, count,   e, i, n) {
  if (mode == "whole") return be - 1
  e = be - 1
  n = 0
  for (i = ts + 1; i < be; i++) {
    if (index(lines[i], indent) == 1) {
      n++
      if (n >= count) { e = i - 1; break }
    }
  }
  return e
}

END {
  n = split(hosts, host_list, ",")
  # 过滤空项
  m = 0
  for (i = 1; i <= n; i++) {
    h = host_list[i]
    gsub(/^[ \t\r]+/, "", h)
    gsub(/[ \t\r]+$/, "", h)
    if (h != "") { m++; clean[m] = h }
  }

  # 三个区域定义：名称、起始标记、结束标记、条目缩进、模板模式
  rname[1] = "ALLOWED HTTP VHOSTS"
  rbegin[1] = ">>> ALLOWED HTTP VHOSTS BEGIN"
  rend[1] = "<<< ALLOWED HTTP VHOSTS END"
  rindent[1] = "                    - name: "
  rmode[1] = "first"
  rcount[1] = 1

  rname[2] = "ALLOWED SNI CHAINS"
  rbegin[2] = ">>> ALLOWED SNI CHAINS BEGIN"
  rend[2] = "<<< ALLOWED SNI CHAINS END"
  rindent[2] = "        - name: "
  rmode[2] = "first"
  rcount[2] = 1

  rname[3] = "EGRESS CLUSTERS"
  rbegin[3] = ">>> EGRESS CLUSTERS BEGIN"
  rend[3] = "<<< EGRESS CLUSTERS END"
  rindent[3] = "    - name: "
  rmode[3] = "count"
  rcount[3] = 3

  # 预生成每个区域的渲染结果
  for (r = 1; r <= 3; r++) {
    bs = find_marker(rbegin[r])
    be = find_marker(rend[r])
    if (bs == 0 || be == 0 || be <= bs) {
      printf("render-allowlist.awk: 未找到区块 %s\n", rname[r]) > "/dev/stderr"
      exit 2
    }
    bs_idx[r] = bs
    be_idx[r] = be
    ts = template_block(bs, be, rindent[r], rmode[r], rcount[r])
    te = template_end(ts, be, rindent[r], rmode[r], rcount[r])
    if (ts == 0) {
      printf("render-allowlist.awk: 区块 %s 内没有模板条目\n", rname[r]) > "/dev/stderr"
      exit 2
    }
    out = ""
    for (i = 1; i <= m; i++) {
      h = clean[i]
      safe = h
      gsub(/[^A-Za-z0-9]/, "_", safe)
      # 正则里使用的转义域名形式（api\.openai\.com）
      esc = h
      gsub(/\./, "\\.", esc)
      for (k = ts; k <= te; k++) {
        l = lines[k]
        # 兼容旧模板：过滤链区块若带 YAML anchor，去掉 anchor（每条链需要各自的上游集群）
        if (r == 2) {
          gsub(/filters: &mitm_http_filters/, "filters:", l)
        }
        gsub(/api_openai_com/, safe, l)
        gsub(/api\\\.openai\\\.com/, esc, l)
        gsub(/api\.openai\.com/, h, l)
        out = out l "\n"
      }
    }
    rendered[r] = out
  }

  # 输出：遇到区块起始标记 → 打印渲染结果 → 跳过区块原有内容
  for (i = 1; i <= NR; i++) {
    handled = 0
    for (r = 1; r <= 3; r++) {
      if (i == bs_idx[r]) {
        print lines[i]
        printf("%s", rendered[r])
        print lines[be_idx[r]]
        i = be_idx[r]
        handled = 1
        break
      }
    }
    if (!handled) print lines[i]
  }
}
