# Visualizador de Processo

Aplicação React/Vite servida por um Cloudflare Worker. Os CSVs publicados são armazenados no Cloudflare D1 para que usuários autenticados consultem os mesmos Jobs em diferentes acessos e dispositivos.

## Acesso

- `VIEWER_PASSWORD`: senha compartilhada para consultar os Jobs.
- `ADMIN_PASSWORD`: senha exclusiva para consultar e publicar CSVs.
- `SESSION_SECRET`: segredo aleatório usado para assinar sessões seguras, válidas por oito horas.

O acesso é compartilhado, sem contas individuais ou histórico por usuário. O endpoint de login limita tentativas por endereço de origem. A senha de administrador não deve ser compartilhada com usuários de consulta. Os valores devem ser definidos como segredos do Worker e nunca adicionados ao código ou ao Git.

## Configuração do Cloudflare

1. Instale as dependências e autentique o Wrangler:

   ```sh
   npm install
   npx wrangler login
   ```

2. Crie o D1:

   ```sh
   npx wrangler d1 create visualizador-processo
   ```

   Copie o `database_id` retornado para `wrangler.jsonc`, substituindo o UUID zerado do campo `database_id`.

3. Configure os segredos do Worker. O Wrangler solicitará os valores sem gravá-los no repositório:

   ```sh
   npx wrangler secret put VIEWER_PASSWORD
   npx wrangler secret put ADMIN_PASSWORD
   npx wrangler secret put SESSION_SECRET
   ```

   Use senhas fortes de pelo menos 12 caracteres, diferentes entre si. Para criar um segredo de sessão aleatório, use `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` e cadastre a saída como `SESSION_SECRET`.

4. Aplique a migração no D1 remoto e publique o Worker:

   ```sh
   npm run db:migrate
   npm run deploy
   ```

   O nome configurado em `wrangler.jsonc` é `visualizadordeprocesso`, correspondente ao Worker do endereço `workers.dev` informado.

   O app limita cada requisição de publicação a 90 MiB para permanecer abaixo do limite de payload do Worker.

5. Compartilhe a senha de consulta com os usuários. Para publicar ou atualizar dados, entre com a senha de administrador e envie os CSVs pelo app. Os dados permanecem disponíveis no D1; a tela mostra a data da última publicação. Ao trocar somente um dos relatórios, o outro conjunto publicado é mantido. Um Job só aparece como **Finalizado** quando todas as suas etapas tiverem quantidade reportada igual ou superior à quantidade planejada.

Para invalidar todas as sessões ativas, troque `SESSION_SECRET` com `npx wrangler secret put SESSION_SECRET`. Para acesso individual por usuário, será necessário migrar para um provedor de identidade.

## Desenvolvimento local

Crie um arquivo `.dev.vars` (ignorado pelo Git) com segredos somente de desenvolvimento:

```ini
VIEWER_PASSWORD="senha-local-de-consulta"
ADMIN_PASSWORD="senha-local-de-administracao"
SESSION_SECRET="um-segredo-local-aleatorio-com-pelo-menos-32-bytes"
```

Inicie o Worker e o app com:

```sh
npm run dev
```

O Wrangler serve a aplicação localmente e usa o banco D1 local com as migrações. Validações:

```sh
npm run lint
npm test
npm run build
```
