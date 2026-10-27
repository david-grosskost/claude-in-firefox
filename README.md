# Claude in Firefox

L'équivalent de *Claude in Chrome* pour Firefox : Claude Code pilote **votre vrai Firefox** (votre profil, vos cookies, vos sessions connectées) pour naviguer, lire les pages, cliquer, remplir des formulaires, faire des captures d'écran, lire la console et le réseau.

```
Claude Code ──stdio/MCP──> serveur MCP (plugin) ──WebSocket 127.0.0.1:8765──> extension Firefox ──> onglets
```

Le projet a deux parties :
- **un plugin Claude Code** (`firefox-pilot`) qui fournit le serveur MCP et une skill expliquant à Claude comment utiliser le navigateur ;
- **une extension Firefox** qui exécute les actions dans les onglets.

## Installation

Il faut **Node.js ≥ 18** et **Firefox ≥ 140**.

### 1. Le plugin Claude Code

Dans Claude Code :

```
/plugin marketplace add david-grosskost/claude-in-firefox
/plugin install firefox-pilot@firefox-pilot
```

Redémarrez ensuite Claude Code. Les outils apparaissent sous la forme `mcp__plugin_firefox-pilot_firefox__*`.

### 2. L'extension Firefox

Téléchargez le fichier `.xpi` de la [dernière release](https://github.com/david-grosskost/claude-in-firefox/releases/latest) et ouvrez-le avec Firefox (ou glissez-le dans une fenêtre Firefox). Ce fichier est signé par Mozilla, donc l'extension reste installée après un redémarrage.

Quand l'extension est connectée à Claude Code, son icône affiche un badge vert avec le nombre de sessions. Un clic sur l'icône montre l'état de la connexion.

### 3. Essayer

Ouvrez Claude Code et demandez par exemple :

> Ouvre wikipedia.org dans Firefox, cherche « Mozilla » et résume l'article.

## Outils

| Outil | Rôle |
|---|---|
| `tabs_context` | Liste les onglets ouverts (ID, titre, URL) |
| `tabs_create` / `tabs_close` | Ouvre ou ferme un onglet |
| `navigate` | Charge une URL, ou `back` / `forward` |
| `read_page` | Arbre d'accessibilité avec des refs (`[ref_12]`), filtre `interactive` ou `all` |
| `find` | Recherche d'éléments par mots-clés, renvoie leurs refs |
| `get_page_text` | Texte visible de la page |
| `computer` | `screenshot`, clics (gauche, droit, double, triple), `hover`, glisser-déposer, `type`, `key`, `scroll`, `scroll_to`, `wait` |
| `form_input` | Remplit un champ, un `<select>` ou une case à cocher via sa ref |
| `javascript_exec` | Exécute du JavaScript dans la page |
| `read_console_messages` | Messages de la console, erreurs non interceptées, ressources en échec |
| `read_network_requests` | Requêtes HTTP de l'onglet |
| `resize_window` | Redimensionne la fenêtre |

Plusieurs sessions Claude Code peuvent tourner en même temps : chaque serveur prend un port libre entre 8765 et 8774, et l'extension se connecte à tous.

## Différences avec Claude in Chrome

Chrome expose le Chrome DevTools Protocol aux extensions, ce que Firefox ne fait pas. Par conséquent :

- Les clics et la saisie sont des **événements synthétiques** envoyés par un script de contenu (`isTrusted === false`). Ils fonctionnent sur la grande majorité des sites, y compris ceux en React, Vue ou Angular. Quelques sites ignorent ces événements, et les popups ouvertes par un clic peuvent être bloquées.
- `hover` déclenche les événements souris, mais pas le style CSS `:hover`.
- Les `<select>` natifs ne s'ouvrent pas au clic : utilisez `form_input`.
- Les iframes provenant d'un autre domaine ne sont pas inspectées.
- Firefox interdit aux extensions les pages `about:`, addons.mozilla.org et le lecteur PDF.
- La capture d'écran active l'onglet visé, car Firefox ne capture que l'onglet visible.
- La console n'est capturée qu'à partir de l'injection du script. Pour un onglet ouvert avant l'installation de l'extension, rechargez la page.

## Sécurité

- Le serveur n'écoute que sur `127.0.0.1` et refuse toute connexion dont l'origine n'est pas `moz-extension://`. Une page web ne peut donc pas s'y connecter.
- Claude agit avec **vos sessions connectées**. Gardez un œil sur ce qu'il fait, surtout sur les sites sensibles (banque, messagerie, achats). La skill lui demande de vous consulter avant tout achat, envoi de message ou suppression.

## Développement

```sh
npm install
npm run build      # regénère server/dist/index.js (à commiter : le plugin l'utilise tel quel)
npm run ext:run    # lance un Firefox avec un profil vierge et l'extension chargée
npm run ext:lint   # vérifie l'extension avec le linter de Mozilla
```

Pour tester le serveur sans passer par le plugin :

```sh
claude mcp add firefox -- node /chemin/vers/claude-in-firefox/server/dist/index.js
```

Pour charger l'extension sans la signer : ouvrez `about:debugging#/runtime/this-firefox`, cliquez sur « Charger un module complémentaire temporaire… » et choisissez `extension/manifest.json`. Elle disparaît au redémarrage de Firefox.

### Publier une version

1. Créez des clés d'API sur <https://addons.mozilla.org/developers/addon/api/key/> et enregistrez-les dans les secrets du dépôt GitHub : `AMO_JWT_ISSUER` et `AMO_JWT_SECRET`.
2. Montez le numéro de version dans `extension/manifest.json` et `.claude-plugin/plugin.json`, lancez `npm run build`, puis commitez.
3. Poussez un tag `vX.Y.Z`. Le workflow `release.yml` fait signer l'extension par Mozilla (canal « unlisted » : signée mais pas listée sur addons.mozilla.org) et publie le `.xpi` dans une release GitHub.

### Configuration

`CLAUDE_IN_FIREFOX_PORT` change le premier port écouté (8765 par défaut). Si vous le modifiez, changez aussi `BASE_PORT` dans `extension/background.js`.

## Licence

[MIT](LICENSE)
