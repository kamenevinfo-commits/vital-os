# VITAL OS

Фитнес-трекер с синхронизацией через Supabase.

## Деплой на GitHub Pages

### 1. Создай репозиторий на GitHub
Назови его `vital-os` (или любое другое имя — тогда поменяй `base` в `vite.config.js`).

### 2. Настрой Supabase
1. Зарегистрируйся на [supabase.com](https://supabase.com)
2. Создай новый проект
3. Зайди в **SQL Editor** и выполни содержимое файла `schema.sql`
4. Зайди в **Settings → API** и скопируй:
   - `Project URL` → `VITE_SUPABASE_URL`
   - `anon public` key → `VITE_SUPABASE_ANON_KEY`

### 3. Добавь секреты в GitHub
Зайди в репозиторий → **Settings → Secrets and variables → Actions** → **New repository secret**:
- `VITE_SUPABASE_URL` — твой Supabase URL
- `VITE_SUPABASE_ANON_KEY` — твой anon key

### 4. Включи GitHub Pages
Зайди в репозиторий → **Settings → Pages** → Source: **gh-pages branch**

### 5. Запушь код
```bash
git init
git add .
git commit -m "initial commit"
git branch -M main
git remote add origin https://github.com/ТВО_ИМЯПОЛЬЗОВАТЕЛЯ/vital-os.git
git push -u origin main
```

GitHub Actions автоматически соберёт и задеплоит сайт.
Сайт будет доступен по адресу: `https://ТВО_ИМЯПОЛЬЗОВАТЕЛЯ.github.io/vital-os/`

## Локальная разработка

```bash
cp .env.example .env
# Заполни .env своими данными

npm install
npm run dev
```
