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

   Os relatórios são enviados em blocos de até 1 MiB, sem um limite fixo de 90 MiB para o conjunto. Todos os relatórios e apontamentos são armazenados com suas colunas e linhas, inclusive repetidas. Para usuários de consulta, o servidor mantém uma cópia compacta com somente os campos usados pelo painel, preparada durante a publicação e associada ao mesmo conjunto. A tela lista os nomes distintos dos responsáveis por cada ordem; o total reportado vem do relatório de Ordens. Os arquivos CSV completos continuam sendo lidos no navegador durante a importação. Permanecem os limites de 100.000 linhas por tipo de relatório e os limites de armazenamento e recursos do Cloudflare e do navegador. Conjuntos antigos continuam disponíveis e são compactados durante a leitura; para aproveitar a cópia pré-processada, o administrador precisa importar novamente os três relatórios. Essa atualização não altera o sequenciamento nem os status de separação.

5. Compartilhe a senha de consulta com os usuários. Para publicar ou atualizar dados, entre com a senha de administrador e envie juntos os três CSVs: OPs, Ordens de Produção e Apontamentos. Cada publicação substitui o conjunto anterior por completo; não é possível atualizar somente alguns relatórios. A tela mostra a data da última publicação. Um Job só aparece como **Finalizado** quando todas as suas etapas tiverem quantidade reportada igual ou superior à quantidade planejada.

Na aba **Corte Laser**, o administrador pode importar separadamente o XLSX de sequenciamento, com as colunas `Máquina`, `Seq`, `Programa`, `Tempo (h)` e `OPs`. O programa é associado ao Job pelo nome exato, sem diferenciar maiúsculas de minúsculas, ou pelas OPs da planilha quando estas identificam um único Job. O Job precisa ter etapa CL nos dados de produção. Programas sem correspondência aparecem em vermelho como **Não encontrado**; se as OPs apontarem para mais de um Job sem correspondência pelo nome, o status será **Vários Jobs encontrados**. Esses programas não exibem percentual nem entram na carga total. A carga soma as horas de cada programa identificado uma vez por máquina e não é rateada entre OPs. A importação substitui o sequenciamento anterior e fica disponível para todos os usuários, independentemente da atualização dos CSVs. O XLSX pode ter até 10 MiB e o sequenciamento processado até 1 MiB ou 10.000 programas.

O progresso de cada programa considera todas as etapas CL do Job associado, inclusive as OPs não listadas na planilha, seguindo o cálculo da Visão de produção com o filtro CL e sem outros filtros aplicados. A porcentagem é a soma das quantidades reportadas dividida pela soma das planejadas, limitada a 100% na exibição. Quando o total reportado é maior que zero e menor que o planejado, o programa aparece como **Corte Parcial**; ao atingir o planejado, com quantidade planejada maior que zero, aparece como **Concluído** e o Job é contado como concluído na máquina. Cada Job identificado é contado uma vez por máquina, mesmo que apareça em vários programas; pode aparecer em mais de uma máquina.

O painel resume, para cada máquina, a carga dos programas encontrados, a quantidade de programas importados e os Jobs identificados por status: concluídos, corte parcial e em andamento. Programas sem Job identificado não entram nesses totais. Os botões filtram a máquina selecionada e mostram todos os programas importados. A pesquisa procura Job, programa, OP, ordem CL e código ou descrição de produto em todas as máquinas, sem alterar os totais do painel; também procura as OPs informadas no XLSX de programas não encontrados. Ao limpar a pesquisa, volta a máquina selecionada. Ao clicar em um programa identificado, são exibidas todas as OPs do Job que têm etapa CL, com o mesmo progresso da Visão de produção filtrada por CL; cada OP pode ser expandida para ver suas etapas. OPs do Job não listadas no XLSX também são mostradas, pois compõem o percentual do Job.

O painel também estima as horas cortadas e restantes por máquina. Para cada programa identificado, divide-se sua carga igualmente entre todas as OPs CL do Job e aplica-se a cada parcela a proporção reportada sobre a planejada daquela OP, limitada a 0–100%. Programas não encontrados ou ambíguos e parcelas de OPs sem quantidade planejada positiva são consideradas integralmente pendentes. A carga total usada nessa estimativa inclui esses programas, diferentemente da carga de programas encontrados. É uma estimativa, não uma medição do tempo real de corte.

Na coluna **Separação**, somente administradores podem marcar cada programa de uma máquina como **Pendente de separação**, **Pago**, **Reprogramar**, **Falta de MP** ou **Aguardando PCP**; todos os usuários autenticados podem consultar o status. Programas sem status salvo começam como **Aguardando PCP**, inclusive os já existentes que nunca foram alterados. Os status salvos anteriormente, inclusive **Pendente de separação**, são preservados. O status é compartilhado por nome exato do programa e da máquina, inclusive entre linhas duplicadas. Alterar a sequência ou reimportar relatórios mantém o status; renomear o programa ou a máquina cria uma associação diferente. O status de separação é independente do progresso de corte.

Para invalidar todas as sessões ativas, troque `SESSION_SECRET` com `npx wrangler secret put SESSION_SECRET`. Para acesso individual por usuário, será necessário migrar para um provedor de identidade.

## Desenvolvimento local

Inicie a aplicação local:

```sh
npm run dev
```

O Vite abre em `http://127.0.0.1:5173` e usa uma API local de desenvolvimento, sem acessar o Worker ou o D1 do Cloudflare. No ambiente local, a autenticação é desativada e o acesso é administrativo. Os dados publicados ficam em `.local/dataset.json`, pasta ignorada pelo Git.

A planilha de sequenciamento importada localmente é salva separadamente em `.local/laser-schedule.json`; os status de separação ficam em `.local/laser-separation.json`. Antes de publicar a funcionalidade no Cloudflare, aplique as migrações com `npm run db:migrate`.

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
