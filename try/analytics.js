/*
 * C123 無料診断版（beta） アクセス解析
 *
 * 送信するのはイベント名だけです。
 * ユーザーが選択したファイルに由来する値（ファイル名・地点名・住所・座標・
 * CSVの内容・差分の件数を含む）は、いかなるパラメータにも入れません。
 *
 * 送信するイベントは次の4つに限定します。
 *   page_view / diagnostic_start / diagnostic_complete / booth_click
 */
(function (global) {
  "use strict";

  var MEASUREMENT_ID = "G-28112XXNX8";
  var ALLOWED_EVENTS = ["diagnostic_start", "diagnostic_complete", "booth_click"];

  global.dataLayer = global.dataLayer || [];
  function gtag() {
    global.dataLayer.push(arguments);
  }
  global.gtag = gtag;

  gtag("js", new Date());
  // page_view はこの config で自動送信されます。
  gtag("config", MEASUREMENT_ID, { anonymize_ip: true });

  // 引数はイベント名だけを受け取ります。値を渡す口を用意しません。
  global.c123Track = function (eventName) {
    if (ALLOWED_EVENTS.indexOf(eventName) === -1) return;
    try {
      gtag("event", eventName);
    } catch (ignored) {
      /* 解析の失敗は診断機能に影響させません（内容は記録しません）。 */
    }
  };
})(window);
