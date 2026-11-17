/* Web版（github.io）の設定。Claude版（build_artifact.py の出力）には入らない。
   ESATJ_GRADER_URL：Claude採点の中継サーバー（grader/ の Cloudflare Worker）のURL。
   空のときは Web版の Claude採点は出ない（本部がデプロイ後にURLを入れる）。 */
window.ESATJ_GRADER_URL = "https://esatj-grader.mutotamaki0813.workers.dev/";
