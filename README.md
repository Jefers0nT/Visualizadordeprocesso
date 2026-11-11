# Painel de OPs

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

   Os relatórios são enviados em blocos de até 1 MiB, sem um limite fixo de 90 MiB para o conjunto. Permanecem os limites de 100.000 linhas por tipo de relatório e os limites de armazenamento e recursos do Cloudflare e do navegador.

5. Compartilhe a senha de consulta com os usuários. Para publicar ou atualizar dados, entre com a senha de administrador e envie juntos os três CSVs: OPs, Ordens de Produção e Apontamentos. Cada publicação substitui o conjunto anterior por completo; não é possível atualizar somente alguns relatórios. A tela mostra a data da última publicação. Um Job só aparece como **Finalizado** quando todas as suas etapas tiverem quantidade reportada igual ou superior à quantidade planejada.

Para invalidar todas as sessões ativas, troque `SESSION_SECRET` com `npx wrangler secret put SESSION_SECRET`. Para acesso individual por usuário, será necessário migrar para um provedor de identidade.

## Desenvolvimento local

Inicie a aplicação local:

```sh
npm run dev
```

O Vite abre em `http://127.0.0.1:5173` e usa uma API local de desenvolvimento, sem acessar o Worker ou o D1 do Cloudflare. No ambiente local, a autenticação é desativada e o acesso é administrativo. Os dados publicados ficam em `.local/dataset.json`, pasta ignorada pelo Git.

Importe sempre os três relatórios juntos: OPs (`Numero da OP`), Ordens de Produção (`Ord Prod`, `Quant Rep`, `Quant Retrab` e `Quant Refug`) e apontamentos (`Ord Prod`, `Desc Máquina` e `Nome Usuário`). Cada importação substitui o conjunto local anterior. Os apontamentos são associados às etapas pela chave `Ord Prod`; máquina e usuário vêm do terceiro relatório, enquanto quantidade reportada, retrabalho e refugo vêm do relatório de Ordens. Faça uma cópia local dos relatórios se quiser manter os dados após limpar `.local`.

Para testar o Worker com o D1 local do Wrangler, crie `.dev.vars` (também ignorado pelo Git) com credenciais somente de desenvolvimento e use:

```sh
npm run dev:worker
```

Validações:

```sh
npm run lint
npm test
npm run build
```
