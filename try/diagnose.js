/*
 * C123 無料診断版（beta） 診断ロジック + UI
 *
 * この無料版は有料版とは別ビルドです。有料版のコード（差分の全件表示・
 * CSV保存・HTML保存・出力用の行組み立て）は、このファイルにも同梱の他の
 * ファイルにも存在しません。差分の件数を出すために必要な最小限の照合
 * ロジックだけを実装しています。
 *
 * 出力の制限は「表示上の制限」ではなく「構造上の制限」です。
 * runDiagnostic() は件数と先頭3件までのプレビューしか返しません。
 * 4件目以降のレコードは関数の外へ出ないため、画面・DOM・console・
 * ダウンロード・localStorage・IndexedDB・URL のいずれにも出力できません。
 *
 * このファイルには console 出力・ダウンロード生成・永続化処理を含みません。
 */
(function () {
  "use strict";

  var PREVIEW_LIMIT = 3;
  var FIELDS = ["タイトル", "メモ", "URL", "タグ", "コメント"];
  var REQUIRED_FIELDS = ["タイトル", "URL"];

  /* ---------------- CSV 読み取り ---------------- */

  function parseCsv(text) {
    var source = String(text || "").replace(/^\uFEFF/, "");
    var rows = [];
    var row = [];
    var field = "";
    var quoted = false;
    for (var i = 0; i < source.length; i += 1) {
      var character = source[i];
      if (quoted) {
        if (character === '"') {
          if (source[i + 1] === '"') {
            field += '"';
            i += 1;
          } else {
            quoted = false;
          }
        } else {
          field += character;
        }
      } else if (character === '"' && field === "") {
        quoted = true;
      } else if (character === ",") {
        row.push(field);
        field = "";
      } else if (character === "\r" || character === "\n") {
        if (character === "\r" && source[i + 1] === "\n") i += 1;
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else {
        field += character;
      }
    }
    if (quoted) throw new Error("csv_unclosed_quote");
    if (field !== "" || row.length > 0) {
      row.push(field);
      rows.push(row);
    }
    return rows;
  }

  function cleanCell(cell) {
    return String(cell).trim().replace(/^\uFEFF/, "");
  }

  function headerIndex(rows) {
    for (var index = 0; index < rows.length; index += 1) {
      var cells = rows[index].map(cleanCell);
      var hasAll = REQUIRED_FIELDS.every(function (name) {
        return cells.indexOf(name) >= 0;
      });
      if (hasAll) return index;
    }
    throw new Error("csv_header_not_found");
  }

  function normalizeSpace(value) {
    return String(value || "")
      .trim()
      .toLocaleLowerCase("und")
      .split(/\s+/u)
      .filter(Boolean)
      .join(" ");
  }

  // 端末内だけで使う照合キー。記録も送信もしません。
  function privateKey(value) {
    var normalized = normalizeSpace(value);
    return normalized ? "local:" + normalized : "";
  }

  function sourceListKey(rows, headerAt, hint) {
    var values = [];
    for (var i = 0; i < headerAt; i += 1) {
      var nonEmpty = rows[i].map(cleanCell).filter(Boolean);
      if (nonEmpty.length) values.push(nonEmpty.join("\u001f"));
    }
    return privateKey(values.length ? values[values.length - 1] : hint);
  }

  function parseSavedCsvText(text, hint) {
    var rows = parseCsv(text);
    if (!rows.length) return [];
    var headerAt = headerIndex(rows);
    var header = rows[headerAt].map(cleanCell);
    var indexes = {};
    FIELDS.forEach(function (name) {
      var at = header.indexOf(name);
      if (at >= 0) indexes[name] = at;
    });
    var listKey = sourceListKey(rows, headerAt, hint || "");
    var records = [];
    for (var i = headerAt + 1; i < rows.length; i += 1) {
      var row = rows[i];
      if (!row.length) continue;
      var hasContent = row.some(function (cell) {
        return cell.trim() !== "";
      });
      if (!hasContent) continue;
      var value = (function (currentRow) {
        return function (name) {
          var at = indexes[name];
          return at === undefined || at >= currentRow.length ? "" : currentRow[at].trim();
        };
      })(row);
      var title = value("タイトル");
      var url = value("URL");
      if (!title && !url) continue;
      records.push({
        title: title,
        memo: value("メモ"),
        url: url,
        tags: value("タグ"),
        comment: value("コメント"),
        listKey: listKey
      });
    }
    return records;
  }

  /* ---------------- 照合キー ---------------- */

  function safeDecode(value) {
    try {
      return decodeURIComponent(value);
    } catch (ignored) {
      return value;
    }
  }

  function stableGoogleId(url) {
    var decoded = safeDecode(String(url || ""));
    var candidates = [
      [/!1s([^!/?#]+)/i, "data"],
      [/[?&](?:query_place_id|place_id)=([^&#]+)/i, "place"],
      [/[?&]cid=([^&#]+)/i, "cid"]
    ];
    for (var i = 0; i < candidates.length; i += 1) {
      var match = decoded.match(candidates[i][0]);
      if (match) return candidates[i][1] + ":" + match[1].toLocaleLowerCase("und");
    }
    return null;
  }

  function normalizedUrl(value) {
    var input = String(value || "").trim();
    if (!input) return null;
    var parsed;
    try {
      parsed = new URL(input);
    } catch (ignored) {
      return null;
    }
    var scheme = parsed.protocol.toLowerCase();
    if (scheme !== "http:" && scheme !== "https:") return null;
    var host = parsed.hostname.toLowerCase();
    if (!host) return null;
    var netloc = parsed.port ? host + ":" + parsed.port : host;
    var path = safeDecode(parsed.pathname).replace(/\/{2,}/g, "/") || "/";
    if (path !== "/") path = path.replace(/\/+$/, "");
    var query = [];
    parsed.searchParams.forEach(function (itemValue, name) {
      var lower = name.toLowerCase();
      if (lower.indexOf("utm_") === 0 || lower === "hl" || lower === "entry") return;
      query.push([name, itemValue]);
    });
    query.sort(function (a, b) {
      return a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0]);
    });
    var search = new URLSearchParams();
    query.forEach(function (pair) {
      search.append(pair[0], pair[1]);
    });
    var queryText = search.toString();
    return scheme + "//" + netloc + path + (queryText ? "?" + queryText : "");
  }

  function payloadKey(record) {
    return JSON.stringify([
      record.title,
      record.memo,
      record.url,
      record.tags,
      record.comment,
      record.listKey
    ]);
  }

  function weakFingerprint(record) {
    return JSON.stringify([
      normalizeSpace(record.title),
      record.listKey,
      normalizeSpace(record.tags)
    ]);
  }

  function addGroup(groups, key, index) {
    if (!key) return;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(index);
  }

  function groupIndexes(records, remaining, keyFunction) {
    var groups = new Map();
    remaining.forEach(function (index) {
      addGroup(groups, keyFunction(records[index]), index);
    });
    return groups;
  }

  function sharedKeys(left, right) {
    var keys = [];
    left.forEach(function (unusedValue, key) {
      if (right.has(key)) keys.push(key);
    });
    return keys;
  }

  /* ---------------- 診断（件数 + 先頭3件のみを返す） ----------------
   *
   * 途中で作る照合結果はこの関数のローカル変数にとどまり、外へ出ません。
   * 返り値に含まれる詳細は最大3件です。
   */
  function runDiagnostic(before, after) {
    var old = before;
    var current = after;
    var oldLeft = new Set(
      old.map(function (unused, index) {
        return index;
      })
    );
    var newLeft = new Set(
      current.map(function (unused, index) {
        return index;
      })
    );

    var removedTitles = [];
    var addedTitles = [];
    var changedPairs = [];
    var reviewGroups = [];

    function pushReview(oldIndexes, newIndexes) {
      reviewGroups.push({
        size: Math.max(oldIndexes.length, newIndexes.length),
        beforeTitles: oldIndexes.map(function (index) {
          return old[index].title;
        }),
        afterTitles: newIndexes.map(function (index) {
          return current[index].title;
        })
      });
    }

    // 1. 完全一致（変化なし）を取り除く
    var exactOld = new Map();
    var exactNew = new Map();
    old.forEach(function (record, index) {
      addGroup(exactOld, payloadKey(record), index);
    });
    current.forEach(function (record, index) {
      addGroup(exactNew, payloadKey(record), index);
    });
    sharedKeys(exactOld, exactNew).forEach(function (key) {
      var pairs = Math.min(exactOld.get(key).length, exactNew.get(key).length);
      exactOld.get(key).slice(0, pairs).forEach(function (index) {
        oldLeft.delete(index);
      });
      exactNew.get(key).slice(0, pairs).forEach(function (index) {
        newLeft.delete(index);
      });
    });

    // 2. Google側の安定IDでの照合
    var strongPasses = [
      function (record) {
        var id = stableGoogleId(record.url);
        return id ? id + "|" + record.listKey : null;
      },
      function (record) {
        return stableGoogleId(record.url);
      }
    ];
    strongPasses.forEach(function (keyFunction) {
      var oldGroups = groupIndexes(old, oldLeft, keyFunction);
      var newGroups = groupIndexes(current, newLeft, keyFunction);
      sharedKeys(oldGroups, newGroups).forEach(function (key) {
        var oldIndexes = oldGroups.get(key);
        var newIndexes = newGroups.get(key);
        oldIndexes.forEach(function (index) {
          oldLeft.delete(index);
        });
        newIndexes.forEach(function (index) {
          newLeft.delete(index);
        });
        if (oldIndexes.length === 1 && newIndexes.length === 1) {
          changedPairs.push([old[oldIndexes[0]].title, current[newIndexes[0]].title]);
        } else {
          pushReview(oldIndexes, newIndexes);
        }
      });
    });

    // 3. 正規化したURLでの照合
    var oldUrls = groupIndexes(old, oldLeft, function (record) {
      return normalizedUrl(record.url);
    });
    var newUrls = groupIndexes(current, newLeft, function (record) {
      return normalizedUrl(record.url);
    });
    sharedKeys(oldUrls, newUrls).forEach(function (key) {
      var oldIndexes = oldUrls.get(key);
      var newIndexes = newUrls.get(key);
      oldIndexes.forEach(function (index) {
        oldLeft.delete(index);
      });
      newIndexes.forEach(function (index) {
        newLeft.delete(index);
      });
      if (oldIndexes.length === 1 && newIndexes.length === 1) {
        changedPairs.push([old[oldIndexes[0]].title, current[newIndexes[0]].title]);
      } else {
        pushReview(oldIndexes, newIndexes);
      }
    });

    // 4. 弱い手がかり（タイトル・タグ）での照合 → 要確認
    var oldWeak = groupIndexes(old, oldLeft, weakFingerprint);
    var newWeak = groupIndexes(current, newLeft, weakFingerprint);
    sharedKeys(oldWeak, newWeak).forEach(function (key) {
      var oldIndexes = oldWeak.get(key);
      var newIndexes = newWeak.get(key);
      oldIndexes.forEach(function (index) {
        oldLeft.delete(index);
      });
      newIndexes.forEach(function (index) {
        newLeft.delete(index);
      });
      pushReview(oldIndexes, newIndexes);
    });

    // 5. 残ったもの
    var weakOldTitles = [];
    var weakNewTitles = [];
    oldLeft.forEach(function (index) {
      if (stableGoogleId(old[index].url)) removedTitles.push(old[index].title);
      else weakOldTitles.push(old[index].title);
    });
    newLeft.forEach(function (index) {
      if (stableGoogleId(current[index].url)) addedTitles.push(current[index].title);
      else weakNewTitles.push(current[index].title);
    });
    if (weakOldTitles.length || weakNewTitles.length) {
      reviewGroups.push({
        size: Math.max(weakOldTitles.length, weakNewTitles.length),
        beforeTitles: weakOldTitles,
        afterTitles: weakNewTitles
      });
    }

    var counts = {
      removed: removedTitles.length,
      added: addedTitles.length,
      changed: changedPairs.length,
      review: reviewGroups.reduce(function (sum, group) {
        return sum + group.size;
      }, 0)
    };
    var totalRows =
      removedTitles.length + addedTitles.length + changedPairs.length + reviewGroups.length;

    // プレビューは先頭3件で打ち切ります。4件目以降はここで捨てられ、
    // 呼び出し側からは到達できません。
    var preview = [];
    function offer(stateLabel, beforeText, afterText) {
      if (preview.length >= PREVIEW_LIMIT) return;
      preview.push({ state: stateLabel, before: beforeText, after: afterText });
    }
    removedTitles.forEach(function (title) {
      offer("今回見つからない", title, "—");
    });
    addedTitles.forEach(function (title) {
      offer("今回増えた", "—", title);
    });
    changedPairs.forEach(function (pair) {
      offer("変更の可能性", pair[0], pair[1]);
    });
    reviewGroups.forEach(function (group) {
      offer(
        "要確認（" + group.size + "件）",
        group.beforeTitles.join(" / ") || "—",
        group.afterTitles.join(" / ") || "—"
      );
    });

    return { counts: counts, totalRows: totalRows, preview: preview };
  }

  /* ---------------- ファイル読み込み ---------------- */

  function recordsFromFiles(fileList) {
    var files = Array.prototype.slice.call(fileList).filter(function (file) {
      return file.name.toLowerCase().slice(-4) === ".csv";
    });
    if (!files.length) return Promise.reject(new Error("no_csv"));
    var records = [];
    return files
      .reduce(function (chain, file) {
        return chain.then(function () {
          return file.arrayBuffer().then(function (buffer) {
            var text = new TextDecoder("utf-8").decode(buffer);
            records.push.apply(
              records,
              parseSavedCsvText(text, file.webkitRelativePath || file.name)
            );
          });
        });
      }, Promise.resolve())
      .then(function () {
        return { fileCount: files.length, records: records };
      });
  }

  /* ---------------- UI ---------------- */

  function track(eventName) {
    if (typeof window.c123Track === "function") window.c123Track(eventName);
  }

  function initialize() {
    var byId = function (id) {
      return document.getElementById(id);
    };
    var state = { before: null, after: null, running: false };
    var button = byId("diagnose");
    var message = byId("message");
    var labels = {
      before: { missing: "前回のデータ", reselect: "前回のフォルダを選び直す" },
      after: { missing: "今回のデータ", reselect: "今回のフォルダを選び直す" }
    };

    function refreshReadiness() {
      var missing = ["before", "after"]
        .filter(function (side) {
          return !state[side];
        })
        .map(function (side) {
          return labels[side].missing;
        });
      button.disabled = state.running || missing.length > 0;
      if (state.running) return;
      message.className = "message";
      message.textContent = missing.length
        ? missing.join("と") + "を選んでください。"
        : "2つとも選択済みです。診断できます。";
    }

    function choose(side, fileList) {
      var status = byId(side + "-status");
      var card = byId(side + "-card");
      state[side] = null;
      byId("result").hidden = true;
      card.classList.remove("is-selected");
      status.className = "status is-loading";
      status.textContent = "読み込んでいます…";
      button.disabled = true;
      recordsFromFiles(fileList).then(
        function (loaded) {
          state[side] = loaded;
          status.className = "status is-selected";
          status.textContent =
            "選択済み：" +
            loaded.records.length +
            "件を読み込みました（CSV " +
            loaded.fileCount +
            "件）";
          card.classList.add("is-selected");
          byId(side + "-folder-label").textContent = labels[side].reselect;
          refreshReadiness();
        },
        function () {
          // エラーの内容（ファイル名・ファイルの中身）は画面にも記録にも使いません。
          state[side] = null;
          status.className = "status is-error";
          status.textContent = "読み込みできませんでした";
          message.className = "message is-error";
          message.textContent =
            "データを読み込めませんでした。Google Takeoutを解凍したフォルダ、またはその中の保存済みリストCSVを選び直してください。";
          button.disabled = true;
        }
      );
    }

    ["before", "after"].forEach(function (side) {
      byId(side + "-folder").addEventListener("change", function (event) {
        choose(side, event.target.files);
      });
      byId(side + "-files").addEventListener("change", function (event) {
        choose(side, event.target.files);
      });
    });

    function render(result) {
      byId("removed-count").textContent = result.counts.removed;
      byId("added-count").textContent = result.counts.added;
      byId("changed-count").textContent = result.counts.changed;
      byId("review-count").textContent = result.counts.review;

      var total =
        result.counts.removed +
        result.counts.added +
        result.counts.changed +
        result.counts.review;
      byId("total-line").textContent =
        total === 0
          ? "差分は見つかりませんでした（合計 0 件）。"
          : "差分の合計は " + total + " 件です。";

      var body = byId("preview-body");
      body.textContent = "";
      if (!result.preview.length) {
        var emptyRow = document.createElement("tr");
        var emptyCell = document.createElement("td");
        emptyCell.colSpan = 3;
        emptyCell.textContent = "表示する差分はありません。";
        emptyRow.appendChild(emptyCell);
        body.appendChild(emptyRow);
      } else {
        result.preview.forEach(function (item) {
          var row = document.createElement("tr");
          [
            ["状態", item.state],
            ["前回", item.before],
            ["今回", item.after]
          ].forEach(function (pair, index) {
            var cell = document.createElement("td");
            cell.dataset.label = pair[0];
            // ユーザー入力由来の文字列は textContent でのみ描画します。
            cell.textContent = pair[1];
            if (index === 0) cell.className = "cell-state";
            row.appendChild(cell);
          });
          body.appendChild(row);
        });
      }

      var locked = byId("locked-line");
      if (result.totalRows > result.preview.length) {
        locked.hidden = false;
        locked.textContent =
          "4件目以降の詳細は、無料診断版では表示しません。有料版で確認できます。";
      } else {
        locked.hidden = true;
        locked.textContent = "";
      }
    }

    button.addEventListener("click", function () {
      if (!state.before || !state.after || state.running) return;
      state.running = true;
      button.disabled = true;
      button.textContent = "診断しています…";
      message.className = "message";
      message.textContent = "ブラウザ内で比較しています。";
      track("diagnostic_start");

      // 「診断しています…」を描画させてから比較に入ります。
      // requestAnimationFrame は非表示タブで停止するため使いません。
      window.setTimeout(function () {
        try {
          var result = runDiagnostic(state.before.records, state.after.records);
          render(result);
          var panel = byId("result");
          panel.hidden = false;
          message.className = "message is-success";
          message.textContent =
            "診断が完了しました（前回 " +
            state.before.records.length +
            "件 / 今回 " +
            state.after.records.length +
            "件）。";
          panel.focus({ preventScroll: true });
          panel.scrollIntoView({ behavior: "smooth", block: "start" });
          track("diagnostic_complete");
        } catch (ignored) {
          // エラーの内容は画面にも記録にも使いません。
          message.className = "message is-error";
          message.textContent =
            "診断できませんでした。2つのデータを選び直して、もう一度お試しください。";
        }
        state.running = false;
        button.textContent = "無料で診断する";
        button.disabled = !(state.before && state.after);
      }, 0);
    });

    byId("booth-cta").addEventListener("click", function () {
      track("booth_click");
    });
    if (byId("booth-cta-top")) {
      byId("booth-cta-top").addEventListener("click", function () {
        track("booth_click");
      });
    }

    refreshReadiness();
  }

  document.addEventListener("DOMContentLoaded", initialize);
})();
