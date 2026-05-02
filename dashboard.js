(function () {
  "use strict";

  function toRegexList(list, fallback) {
    var src = Array.isArray(list) && list.length ? list : fallback;
    return src.map(function (p) {
      return new RegExp(p, "i");
    });
  }

  function buildPatterns(config) {
    return {
      name: toRegexList(null, ["^name$", "what('?s| is)\\s+your\\s+name", "\\bfull\\s+name\\b"]),
      monthlyStatus: toRegexList(null, ["accomplish", "successful", "result", "how did", "on track", "pivot", "check-?in", "check in"]),
      quarterlyStatus: toRegexList(null, ["\\bq[1-4]\\b", "quarterly", "\\bq[1-4]\\s+goal\\b"]),
      quarterlyGoals: toRegexList(null, ["^q[1-4]\\s+goal\\s*\\d+"]),
      monthlyGoals: toRegexList(null, ["goal\\s*\\d+"]),
      skipColumns: toRegexList(null, ["^timestamp$", "^email address$", "^email$"])
    };
  }

  function matchesAny(value, regexList) {
    for (var i = 0; i < regexList.length; i++) {
      if (regexList[i].test(value)) return true;
    }
    return false;
  }

  function normaliseName(value) {
    return String(value || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]/g, "");
  }

  function dedupeNonEmpty(items) {
    var seen = new Set();
    var out = [];
    items.forEach(function (v) {
      var t = String(v || "").trim().replace(/\s+/g, " ");
      if (!t || seen.has(t)) return;
      seen.add(t);
      out.push(t);
    });
    return out;
  }

  function getCanonicalVariants(config, memberName) {
    var aliases = (config.memberAliases && config.memberAliases[memberName]) || [];
    var variants = [memberName].concat(aliases).map(normaliseName).filter(Boolean);
    return new Set(variants);
  }

  function gvizToRows(gvizResponse) {
    var table = gvizResponse && gvizResponse.table;
    if (!table || !table.cols || !table.rows) return null;
    var headers = table.cols.map(function (col) {
      return String((col && (col.label || col.id)) || "").trim();
    });
    var dataRows = table.rows.map(function (r) {
      return (r.c || []).map(function (cell) {
        return cell && cell.v != null ? String(cell.v).trim() : "";
      });
    });
    return [headers].concat(dataRows);
  }

  function fetchGvizJsonp(config, month) {
    return new Promise(function (resolve, reject) {
      var cbName = "__dashGvizCb_" + Date.now() + "_" + Math.random().toString(36).slice(2);
      var script = document.createElement("script");
      var tqx = "out:json;responseHandler:" + cbName;
      var src = "https://docs.google.com/spreadsheets/d/" + config.sheetId + "/gviz/tq?gid=" +
        encodeURIComponent(month.gid) + "&tqx=" + encodeURIComponent(tqx);
      var settled = false;

      function cleanup() {
        clearTimeout(timeoutId);
        delete window[cbName];
        script.remove();
      }

      function settle(err, rows) {
        if (settled) return;
        settled = true;
        cleanup();
        if (err) reject(err);
        else resolve(rows);
      }

      var timeoutId = setTimeout(function () {
        settle(new Error("timeout"));
      }, 15000);

      window[cbName] = function (payload) {
        var rows = gvizToRows(payload);
        settle(rows ? null : new Error("bad gviz payload"), rows);
      };

      script.onerror = function () {
        settle(new Error("script load failed"));
      };
      script.src = src;
      document.head.appendChild(script);
    });
  }

  async function fetchSheet(config, month) {
    var hasGid = month.gid && String(month.gid).indexOf("YOUR_") === -1;
    if (!hasGid) return { rows: null, skipped: true };

    var tryJsonp = async function (error) {
      try {
        return await fetchGvizJsonp(config, month);
      } catch {
        return { rows: null, error: error };
      }
    };

    return tryJsonp("gviz jsonp failed");
  }

  function extractUserData(config, rows, name, monthLabel) {
    if (!rows || rows.length < 2) return null;

    var patterns = buildPatterns(config);
    var headersOriginal = rows[0];
    var headers = headersOriginal.map(function (h) {
      return String(h || "").toLowerCase().trim();
    });

    var nameCol = headers.findIndex(function (h) {
      return matchesAny(h, patterns.name);
    });
    if (nameCol === -1) return null;

    var variants = getCanonicalVariants(config, name);
    var candidateRows = rows.slice(1).filter(function (r) {
      return variants.has(normaliseName(r[nameCol] || ""));
    });
    var rawUserRow = candidateRows[candidateRows.length - 1];
    if (!rawUserRow) return null;
    var userRow = rawUserRow.slice();
    while (userRow.length < headers.length) userRow.push("");

    var monthGoals = [];
    var qGoals = [];
    var monthlyStatus = "";
    var quarterlyStatus = "";
    var unknownNonEmpty = [];

    headers.forEach(function (h, i) {
      var val = String(userRow[i] || "").trim();
      if (!val) return;

      var isQuarterlyContext = matchesAny(h, patterns.quarterlyStatus);

      if (i === nameCol || matchesAny(h, patterns.skipColumns)) {
        return;
      }
      if (matchesAny(h, patterns.quarterlyGoals)) {
        qGoals.push({ label: headersOriginal[i], value: val });
        return;
      }
      if (matchesAny(h, patterns.monthlyGoals) && !isQuarterlyContext) {
        monthGoals.push(val);
        return;
      }
      if (matchesAny(h, patterns.monthlyStatus)) {
        if (isQuarterlyContext) quarterlyStatus = val;
        else monthlyStatus = val;
        return;
      }
      unknownNonEmpty.push(headersOriginal[i] || h);
    });

    if (unknownNonEmpty.length) {
      console.warn("[dashboard] Unmapped non-empty columns in", monthLabel || "unknown month", unknownNonEmpty);
    }

    return {
      monthGoals: dedupeNonEmpty(monthGoals),
      qGoals: dedupeNonEmpty(qGoals.map(function (g) { return g.value; })).map(function (v) { return { value: v }; }),
      monthlyStatus: String(monthlyStatus || "").trim(),
      quarterlyStatus: String(quarterlyStatus || "").trim()
    };
  }

  function categoriseResult(text) {
    if (!text) return "pending";
    var t = String(text).toLowerCase().trim();
    if (t === "yes") return "success";
    if (t === "no") return "fail";
    if (/\byes\b|✅|accomplished|fully|100|on track/.test(t)) return "success";
    if (/^no(?:\b|[\s:;,.!?()\-])|❌|not accomplished|failed|0%|off track/.test(t)) return "fail";
    return "partial";
  }

  function summariseStatuses(withData) {
    var out = { success: 0, fail: 0, partial: 0, pending: 0 };
    (withData || []).forEach(function (entry) {
      var d = entry.data || {};
      ["monthlyStatus", "quarterlyStatus"].forEach(function (k) {
        var type = categoriseResult(d[k] || "");
        out[type] += 1;
      });
    });
    return out;
  }

  window.DashboardData = {
    fetchSheet: fetchSheet,
    extractUserData: extractUserData,
    categoriseResult: categoriseResult,
    summariseStatuses: summariseStatuses
  };
})();
